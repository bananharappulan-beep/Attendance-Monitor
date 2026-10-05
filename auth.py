"""Login, roles and user store for Attendance Monitor.

Roles
  developer : everything + user management (add / edit / delete users, reset passwords)
  admin     : all businesses, all windows, PDF download, date changing
  business  : ONE business only (e.g. MAGNUS); the developer decides per user:
                - which windows (daily / matrix / inactive / summary) are visible
                - whether PDF download is allowed
                - whether the date can be changed

Users live in users.json next to this file (override with USERS_FILE).
Passwords are stored ONLY as salted hashes (werkzeug scrypt / pbkdf2), never in plain text.
"""
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

from flask import Blueprint, g, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

log = logging.getLogger("attendance.auth")

BASE_DIR = Path(__file__).resolve().parent
USERS_FILE = BASE_DIR / "users.json"
SECRET_FILE = BASE_DIR / ".secret_key"

ROLES = ("developer", "admin", "business")
TABS = ("daily", "matrix", "inactive", "summary", "punchin")
BUSINESSES = ("MAGNUS", "ALIMS", "M&D", "MERCHX", "HU", "GRANDIS")

# Same mapping as static/js/app.js - used so the SERVER can enforce business scope.
BUSINESS_BRANCHES = {
    "MAGNUS": ["Manjeri", "Kasargod", "Kannur", "Kuttiyadi", "Kozhikode", "Tirur", "Palakkad",
               "Thrissur", "Ernakulam", "Alappuzha", "Kottayam", "Kollam", "Trivandrum",
               "Marthandam", "Nagpur", "Hyderabad", "Bangalore"],
    "ALIMS": ["Manjeri", "Kozhikode", "Ernakulam", "Thrissur", "Trivandrum"],
    "M&D": ["Manjeri", "Ernakulam"],
    "MERCHX": ["Manjeri", "Kozhikode", "Thrissur", "Ernakulam"],
    "HU": ["Manjeri"],
    "GRANDIS": ["Thoduppuzha", "Chennai"],
}
CORE_OFFICE_SOURCES = {"MAGNUS": ["HEAD OFFICE", "MANJERI R&D", "MANJERI FR", "FCO MANJERI"]}
BRANCH_SOURCE_ALIASES = {
    ("MAGNUS", "Kuttiyadi"): "KUTTIYADI",
    ("MERCHX", "Manjeri"): "MERCHX MANJERI",
    ("HU", "Manjeri"): "HU MANJERI",
}

USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,32}$")
MIN_PASSWORD = 8
MAX_FAILS, LOCK_SECONDS = 5, 300

bp = Blueprint("auth", __name__)
_lock = threading.RLock()
_fails = {}   # (ip, username) -> [count, locked_until]


# ---------------------------------------------------------------- hashing
def _hash(password):
    try:
        return generate_password_hash(password, method="scrypt")
    except Exception:                                  # Python built without scrypt
        return generate_password_hash(password, method="pbkdf2:sha256:600000")


_DUMMY_HASH = _hash("not-a-real-password")           # equalises timing for unknown users


# ---------------------------------------------------------------- JSON store
def _read():
    if not USERS_FILE.exists():
        raise FileNotFoundError(f"User store not found: {USERS_FILE}")
    with USERS_FILE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("users", {})
    return data


def _write(data):
    tmp = USERS_FILE.with_name(USERS_FILE.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, USERS_FILE)                       # atomic: never a half-written file
    try:
        os.chmod(USERS_FILE, 0o600)
    except OSError:
        pass


def _now():
    return datetime.now().isoformat(timespec="seconds")


def get_user(username):
    with _lock:
        return _read()["users"].get(str(username or "").strip().lower())


def list_users():
    with _lock:
        users = _read()["users"].values()
    return [public_user(u) for u in sorted(users, key=lambda u: (ROLES.index(u["role"]), u["username"]))]


def _normalize_permissions(role, perms):
    perms = perms or {}
    if role != "business":
        return {"download": True, "change_date": True, "tabs": list(TABS)}
    tabs = [t for t in TABS if t in (perms.get("tabs") or [])]
    return {"download": bool(perms.get("download")), "change_date": bool(perms.get("change_date")),
            "tabs": tabs}


def public_user(u):
    perms = _normalize_permissions(u["role"], u.get("permissions"))
    return {
        "username": u["username"], "display_name": u.get("display_name") or u["username"],
        "role": u["role"], "business": u.get("business") or "", "permissions": perms,
        "active": u.get("active", True), "must_change_password": u.get("must_change_password", False),
        "created_at": u.get("created_at", ""), "updated_at": u.get("updated_at", ""),
    }


def _validate_password(password, username=""):
    if len(password or "") < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Password must contain at least one letter and one number."
    if username and password.lower() == username.lower():
        return "Password must not be the same as the username."
    return None


def _active_developers(users, excluding=None):
    return [u for n, u in users.items()
            if u["role"] == "developer" and u.get("active", True) and n != excluding]


def ensure_user_store():
    """Validate the existing user store without creating or modifying it."""
    if not USERS_FILE.is_file():
        raise FileNotFoundError(f"User store not found: {USERS_FILE}")
    with _lock:
        data = _read()
        users = data.get("users")
        if not isinstance(users, dict) or not users:
            raise ValueError(f"User store contains no accounts: {USERS_FILE}")
        if not any(user.get("active", True) for user in users.values()):
            raise ValueError(f"User store contains no active accounts: {USERS_FILE}")


# ---------------------------------------------------------------- session / guards
def current_user():
    if "_auth_user" in g:
        return g._auth_user
    user = None
    name = session.get("u")
    if name:
        rec = get_user(name)
        if rec and rec.get("active", True) and rec.get("pw_changed", "") == session.get("pv", ""):
            user = rec
        else:
            session.clear()                           # disabled / deleted / password was reset
    g._auth_user = user
    return user


def _guard(fn, enforce_change):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error="Login required.", login=True), 401
        if enforce_change and user.get("must_change_password"):
            return jsonify(error="You must change your password first.", must_change_password=True), 403
        return fn(*args, **kwargs)
    return wrapper


def login_required(fn):
    return _guard(fn, True)


def session_required(fn):
    return _guard(fn, False)


def roles_required(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if current_user()["role"] not in roles:
                return jsonify(error="You do not have permission for this action."), 403
            return fn(*args, **kwargs)
        return login_required(wrapper)
    return deco


# ---------------------------------------------------------------- access rules used by the API
def _perms(user):
    return _normalize_permissions(user["role"], user.get("permissions"))


def can_view_tab(user, *tabs):
    allowed = set(_perms(user)["tabs"])
    return any(t in allowed for t in tabs)


def can_change_date(user):
    return _perms(user)["change_date"]


def can_download(user):
    return _perms(user)["download"]


def business_sources(business):
    business = str(business or "").upper()
    out = set()
    for branch in BUSINESS_BRANCHES.get(business, []):
        alias = BRANCH_SOURCE_ALIASES.get((business, branch))
        out.add((alias or (branch if business == "MAGNUS" else f"{business} {branch}")).upper())
    out.update(CORE_OFFICE_SOURCES.get(business, []))
    return out


def branch_allowed(user, branch):
    if user["role"] != "business":
        return True
    return str(branch or "").strip().upper() in business_sources(user.get("business"))


def filter_branches(user, names):
    return [n for n in names if branch_allowed(user, n)]


def latest_date_only(rows):
    """Date locked: keep only the newest day's rows. Employees with no row that day stay
    on the roster as blank rows (= absent) so counts remain correct."""
    latest = max((r.get("d") for r in rows if r.get("d")), default=None)
    if not latest:
        return []
    out = [dict(r) for r in rows if r.get("d") == latest]
    seen = {r.get("name") for r in out}
    for r in rows:
        if r.get("name") not in seen:
            seen.add(r.get("name"))
            out.append({"d": latest, "code": r.get("code", ""), "name": r.get("name"),
                        "inT": "", "outT": "", "dur": ""})
    return out


def limit_matrix_to_latest_month(matrix):
    dates = sorted(matrix.get("dates") or [])
    if not dates:
        return matrix
    keep = {d for d in dates if d[:7] == dates[-1][:7]}
    rows = [{**r, "statuses": {d: v for d, v in (r.get("statuses") or {}).items() if d in keep}}
            for r in matrix.get("rows", [])]
    return {**matrix, "dates": [d for d in dates if d in keep], "rows": rows}


# ---------------------------------------------------------------- login throttle
def _locked_for(key):
    rec = _fails.get(key)
    if rec and rec[1] > time.time():
        return int(rec[1] - time.time())
    return 0


def _register_fail(key):
    rec = _fails.setdefault(key, [0, 0])
    if rec[1] and rec[1] <= time.time():
        rec[0], rec[1] = 0, 0
    rec[0] += 1
    if rec[0] >= MAX_FAILS:
        rec[1] = time.time() + LOCK_SECONDS


# ---------------------------------------------------------------- routes
@bp.get("/login")
def login_page():
    if current_user():
        return redirect("/")
    return render_template("login.html")


@bp.post("/api/login")
def api_login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip().lower()
    password = str(body.get("password", ""))
    key = (request.remote_addr or "?", username)
    wait = _locked_for(key)
    if wait:
        return jsonify(error=f"Too many failed attempts. Try again in {wait // 60 + 1} minute(s)."), 429

    user = get_user(username)
    if user and user.get("active", True):
        ok = check_password_hash(user["password_hash"], password)
    else:
        check_password_hash(_DUMMY_HASH, password)
        ok = False
    if not ok:
        _register_fail(key)
        return jsonify(error="Invalid username or password."), 401

    _fails.pop(key, None)
    session.clear()
    session.permanent = True
    session["u"] = user["username"]
    session["pv"] = user.get("pw_changed", "")
    return jsonify(ok=True)


@bp.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@bp.get("/logout")
def logout_page():
    session.clear()
    return redirect("/login")


@bp.get("/api/me")
@session_required
def api_me():
    return jsonify(public_user(current_user()))


@bp.post("/api/change-password")
@session_required
def api_change_password():
    user = current_user()
    body = request.get_json(silent=True) or {}
    current, new = str(body.get("current_password", "")), str(body.get("new_password", ""))
    if not check_password_hash(user["password_hash"], current):
        return jsonify(error="Current password is incorrect."), 400
    if new == current:
        return jsonify(error="New password must be different from the current one."), 400
    problem = _validate_password(new, user["username"])
    if problem:
        return jsonify(error=problem), 400
    with _lock:
        data = _read()
        rec = data["users"][user["username"]]
        rec.update(password_hash=_hash(new), must_change_password=False,
                   pw_changed=_now(), updated_at=_now())
        _write(data)
    session["pv"] = rec["pw_changed"]                 # keep THIS session alive, others are dropped
    return jsonify(ok=True)


# ---- user management (developer only) ----
def _clean_user_fields(body, existing=None):
    role = str(body.get("role", existing["role"] if existing else "")).strip().lower()
    if role not in ROLES:
        raise ValueError("Choose a valid role.")
    business = str(body.get("business", existing.get("business", "") if existing else "")).strip().upper()
    if role == "business":
        if business not in BUSINESSES:
            raise ValueError("Choose a business for a business user.")
    else:
        business = ""
    name = str(body.get("display_name", existing.get("display_name", "") if existing else "")).strip()[:60]
    perms = _normalize_permissions(role, body.get("permissions", existing.get("permissions") if existing else None))
    if role == "business" and not perms["tabs"]:
        raise ValueError("Select at least one window for a business user.")
    return role, business, name, perms


@bp.get("/api/users")
@roles_required("developer")
def api_users():
    return jsonify(list_users())


@bp.post("/api/users")
@roles_required("developer")
def api_user_create():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip().lower()
    password = str(body.get("password", ""))
    if not USERNAME_RE.match(username):
        return jsonify(error="Username: 3-32 characters, letters, numbers, . _ - only."), 400
    problem = _validate_password(password, username)
    if problem:
        return jsonify(error=problem), 400
    try:
        role, business, name, perms = _clean_user_fields(body)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    with _lock:
        data = _read()
        if username in data["users"]:
            return jsonify(error="That username already exists."), 409
        data["users"][username] = {
            "username": username, "display_name": name or username, "role": role,
            "business": business, "permissions": perms, "password_hash": _hash(password),
            "active": True, "must_change_password": bool(body.get("must_change_password", True)),
            "pw_changed": _now(), "created_at": _now(), "updated_at": _now(),
        }
        _write(data)
        return jsonify(public_user(data["users"][username])), 201


@bp.put("/api/users/<username>")
@roles_required("developer")
def api_user_update(username):
    username = username.strip().lower()
    body = request.get_json(silent=True) or {}
    with _lock:
        data = _read()
        rec = data["users"].get(username)
        if not rec:
            return jsonify(error="User not found."), 404
        try:
            role, business, name, perms = _clean_user_fields(body, rec)
        except ValueError as e:
            return jsonify(error=str(e)), 400
        active = bool(body.get("active", rec.get("active", True)))
        if username == current_user()["username"] and (not active or role != "developer"):
            return jsonify(error="You cannot disable or demote your own account."), 400
        if (rec["role"] == "developer" and (role != "developer" or not active)
                and not _active_developers(data["users"], excluding=username)):
            return jsonify(error="At least one active developer must remain."), 400
        rec.update(display_name=name or username, role=role, business=business,
                   permissions=perms, active=active, updated_at=_now())
        new_password = str(body.get("password", ""))
        if new_password:
            problem = _validate_password(new_password, username)
            if problem:
                return jsonify(error=problem), 400
            rec.update(password_hash=_hash(new_password), pw_changed=_now(),
                       must_change_password=bool(body.get("must_change_password", True)))
        elif "must_change_password" in body:
            rec["must_change_password"] = bool(body["must_change_password"])
        _write(data)
        if username == current_user()["username"] and new_password:
            session["pv"] = rec["pw_changed"]
        return jsonify(public_user(rec))


@bp.delete("/api/users/<username>")
@roles_required("developer")
def api_user_delete(username):
    username = username.strip().lower()
    if username == current_user()["username"]:
        return jsonify(error="You cannot delete your own account."), 400
    with _lock:
        data = _read()
        rec = data["users"].get(username)
        if not rec:
            return jsonify(error="User not found."), 404
        if rec["role"] == "developer" and not _active_developers(data["users"], excluding=username):
            return jsonify(error="At least one active developer must remain."), 400
        del data["users"][username]
        _write(data)
    return jsonify(ok=True)


# ---------------------------------------------------------------- app wiring
def _secret_key():
    env = os.getenv("SECRET_KEY", "").strip()
    if env:
        return env
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text().strip()
    key = secrets.token_hex(32)
    SECRET_FILE.write_text(key)
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return key


def init_app(app):
    app.secret_key = _secret_key()
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "0") == "1",   # set 1 when served over HTTPS
        PERMANENT_SESSION_LIFETIME=timedelta(hours=int(os.getenv("SESSION_HOURS", "12"))),
    )
    app.register_blueprint(bp)
    ensure_user_store()

    @app.after_request
    def _no_store(resp):
        if request.path == "/" or request.path.startswith("/api/") or request.path == "/login":
            resp.headers["Cache-Control"] = "no-store"
        return resp