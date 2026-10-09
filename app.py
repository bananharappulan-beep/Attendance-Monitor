"""Attendance Monitor - Flask backend (Neon PostgreSQL storage).

API
  GET /api/branches           -> ["KANNUR", ...]
  GET /api/data?branch=NAME   -> [{d, code, name, inT, outT, dur}, ...]
  GET /api/sync               -> {"rows": N, "branches": M}
                                 (re-read Neon and refresh the dashboard cache)

ESSL -> Neon runs every day at FETCH_HOUR:FETCH_MINUTE (last N days, old rows cleaned up; N is set by a
developer in Sync -> Fetch Days, default FETCH_DAYS) and can
also be started manually by a developer from the Sync sidebar.
"""
import copy
import gzip
import hashlib
import json
import logging
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, Response, jsonify, redirect, render_template, request, stream_with_context
from flask_cors import CORS

try:
    import brotli               # optional: pip install brotli (smaller than gzip)
except ImportError:
    brotli = None

import auth
import db
import neon_sync
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance")
_sync_action_lock = threading.Lock()

# ---------- Data version + backend cache ----------
# Everything read from Neon is cached in memory and kept until the stored data changes.
# Every place that changes the data (daily ESSL fetch, manual fetch, sync, refresh, cleanup)
# calls _bump_version(), which drops the cache and gives the front end a new version id.
_version_lock = threading.Lock()
_version = uuid.uuid4().hex
_cache = {}


def _data_version():
    return _version


def _bump_version():
    global _version
    with _version_lock:
        _version = uuid.uuid4().hex
        _cache.clear()
    log.info("Data changed -> cache cleared (version %s).", _version[:8])


def _cached(key, loader):
    version = _version
    cache_key = (version,) + tuple(key)
    if cache_key in _cache:
        return _cache[cache_key]
    value = loader()
    with _version_lock:
        if version == _version:         # data did not change while loading
            _cache[cache_key] = value
    return value


def _compress_json_response(response):
    """Gzip sizeable JSON API responses when the client supports it."""
    if (
        not response.mimetype == "application/json"
        or response.status_code < 200
        or response.status_code in (204, 304)
        or response.headers.get("Content-Encoding")
        or response.direct_passthrough
    ):
        return response

    response.headers["X-Data-Version"] = _data_version()
    body = response.get_data()
    if request.method == "GET" and response.status_code == 200 and request.path.startswith("/api/"):
        # ETag lets the browser revalidate: unchanged data -> empty 304 instead of the full JSON
        response.set_etag(hashlib.sha1(body).hexdigest(), weak=True)
        response.headers["Cache-Control"] = "private, no-cache"
        response.make_conditional(request)
        if response.status_code == 304:
            return response
    if len(body) < 1024:
        return response

    response.vary.add("Accept-Encoding")
    accepted = request.accept_encodings
    if brotli is not None and accepted.quality("br"):
        encoding, compressed = "br", brotli.compress(body, quality=5)
    elif accepted.quality("gzip"):
        encoding, compressed = "gzip", gzip.compress(body, compresslevel=6, mtime=0)
    else:
        return response

    response.set_data(compressed)
    response.headers["Content-Encoding"] = encoding
    return response


def _scheduled_fetch():
    """Daily job: ESSL -> Neon (the fetch window replaced, older rows deleted), then refresh the cache."""
    if not _sync_action_lock.acquire(blocking=False):
        log.warning("Scheduled ESSL fetch skipped: another sync action is running.")
        return
    try:
        log.info("Scheduled ESSL fetch started.")
        result = subprocess.run(
            [sys.executable, "-u", "-c", "import data_fetch; data_fetch.run()"],
            cwd=str(Path(__file__).resolve().parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=4 * 60 * 60,
        )
        tail = "\n".join((result.stdout or "").splitlines()[-25:])
        if result.returncode:
            log.error("Scheduled ESSL fetch failed (exit %s). Last output:\n%s", result.returncode, tail)
        else:
            log.info("Scheduled ESSL fetch finished. Last output:\n%s", tail)
        neon_sync.sync()            # show whatever was stored, even after a partial failure
        _bump_version()
    except Exception:
        log.exception("Scheduled ESSL fetch crashed")
    finally:
        _sync_action_lock.release()


def start_scheduler():
    if not Config.AUTO_FETCH:
        log.info("Automatic daily fetch is off (AUTO_FETCH=0).")
        return None
    scheduler = BackgroundScheduler(timezone=Config.TIMEZONE)
    scheduler.add_job(
        _scheduled_fetch, "cron", hour=Config.FETCH_HOUR, minute=Config.FETCH_MINUTE,
        id="daily_essl_fetch", coalesce=True, max_instances=1, misfire_grace_time=3600,
    )
    scheduler.start()
    log.info("Daily ESSL fetch scheduled at %02d:%02d (%s).",
             Config.FETCH_HOUR, Config.FETCH_MINUTE, Config.TIMEZONE)
    return scheduler


def create_app():
    app = Flask(__name__)
    app.json.compact = True         # no indent/extra spaces (debug=True otherwise pretty-prints JSON)
    app.json.ensure_ascii = False   # send UTF-8 names as-is instead of \uXXXX escapes
    CORS(app, resources={r"/api/*": {"origins": Config.CORS_ORIGINS, "expose_headers": ["X-Data-Version"]}})
    app.after_request(_compress_json_response)

    auth.init_app(app)          # login, roles, users.json, /login, /api/me, /api/users ...

    @app.get("/")
    def index():
        if not auth.current_user():
            return redirect("/login")
        return render_template("index.html")

    def _deny(msg="You do not have access to this report."):
        return jsonify({"error": msg}), 403

    def _empty_matrix_for_branch(branch):
        skipped = {name.casefold() for name in neon_sync.OUTPUT_SKIP_TABS}
        return {"dates": [], "rows": []} if branch.casefold() in skipped else None

    @app.get("/api/version")
    @auth.login_required
    def data_version():
        return jsonify({"version": _data_version()})

    @app.get("/api/branches")
    @auth.login_required
    def branches():
        try:
            return jsonify(auth.filter_branches(
                auth.current_user(), _cached(("branches",), neon_sync.get_branches)))
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/data")
    @auth.login_required
    def data():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "daily", "summary", "punchin") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            rows = _cached(("data", branch), lambda: neon_sync.get_branch_data(branch))
            if not auth.can_change_date(user):
                rows = auth.latest_date_only(copy.deepcopy(rows))   # date locked -> latest day only
            return jsonify(rows)
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.post("/api/refresh")
    @auth.login_required
    def refresh_data():
        try:
            rows, branches = neon_sync.refresh_cache()
            _bump_version()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual data refresh failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/matrix")
    @auth.login_required
    def matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "matrix") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            result = _cached(("matrix", branch), lambda: neon_sync.get_current_matrix(branch))
            if not auth.can_change_date(user):
                result = auth.limit_matrix_to_latest_month(copy.deepcopy(result))
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/summary-matrix")
    @auth.login_required
    def summary_matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "summary") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            matrix = _cached(("saved", branch), lambda: neon_sync.get_saved_matrix(branch))
            latest_status_date = max(
                (
                    day
                    for row in matrix.get("rows", [])
                    for day, status in row.get("statuses", {}).items()
                    if status in ("P", "H", "A")
                ),
                default="",
            )
            if not latest_status_date:
                return jsonify({"dates": [], "rows": []})
            target = datetime.strptime(latest_status_date, "%Y-%m-%d").date()
            dates = [(target - timedelta(days=offset)).isoformat() for offset in range(3, -1, -1)]
            return jsonify({
                "dates": dates,
                "rows": [
                    {
                        "name": row.get("name", ""),
                        "code": row.get("code", ""),
                        "statuses": {
                            day: row.get("statuses", {}).get(day, "")
                            for day in dates
                        },
                    }
                    for row in matrix.get("rows", [])
                ],
            })
        except Exception as e:
            log.exception("Summary matrix fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/attendance-matrix")
    @auth.login_required
    def attendance_matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if (
            not auth.can_view_tab(user, "daily", "summary", "inactive", "punchin")
            or not auth.branch_allowed(user, branch)
        ):
            return _deny()
        try:
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            return jsonify(_cached(("saved", branch), lambda: neon_sync.get_saved_matrix(branch)))
        except Exception as e:
            log.exception("Attendance matrix fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/attendance-matrices")
    @auth.login_required
    def attendance_matrices():
        user = auth.current_user()
        branches = list(dict.fromkeys(request.args.getlist("branch")))
        if not auth.can_view_tab(user, "summary", "punchin") or any(
            not auth.branch_allowed(user, branch) for branch in branches
        ):
            return _deny()
        try:
            matrices = {}
            output_branches = []
            for branch in branches:
                empty_matrix = _empty_matrix_for_branch(branch)
                if empty_matrix is None:
                    output_branches.append(branch)
                else:
                    matrices[branch] = empty_matrix
            matrices.update(_cached(
                ("saved-many",) + tuple(output_branches),
                lambda: neon_sync.get_saved_matrices(output_branches)))
            return jsonify(matrices)
        except Exception as e:
            log.exception("Attendance matrices fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.post("/api/developer/archive")
    @auth.roles_required("developer")
    def developer_archive():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        try:
            removed = neon_sync.cleanup_old()
            _bump_version()
            return jsonify({
                "ok": True,
                "message": f"Cleanup done: {removed} row(s) older than the {db.fetch_days()}-day window removed.",
            })
        except Exception as e:
            log.exception("Developer cleanup failed")
            return jsonify({"error": str(e)}), 500
        finally:
            _sync_action_lock.release()

    def _fetch_settings():
        start, end = db.fetch_window()
        return {
            "fetch_days": db.fetch_days(),
            "default_days": Config.FETCH_DAYS,          # the .env value, used until a developer changes it
            "min": Config.FETCH_DAYS_MIN,
            "max": Config.FETCH_DAYS_MAX,
            "start": start.isoformat(),
            "end": end.isoformat(),
        }

    @app.get("/api/developer/settings")
    @auth.roles_required("developer")
    def developer_settings():
        try:
            return jsonify(_fetch_settings())
        except Exception as e:
            log.exception("Reading the fetch settings failed")
            return jsonify({"error": str(e)}), 500

    @app.post("/api/developer/settings")
    @auth.roles_required("developer")
    def developer_save_settings():
        body = request.get_json(silent=True) or {}
        raw = body.get("fetch_days")
        lo, hi = Config.FETCH_DAYS_MIN, Config.FETCH_DAYS_MAX
        try:
            if isinstance(raw, bool) or (isinstance(raw, float) and not raw.is_integer()):
                raise ValueError
            days = int(str(raw).strip())
        except ValueError:
            return jsonify({"error": "Enter a whole number of days."}), 400
        if not lo <= days <= hi:
            return jsonify({"error": f"Days must be between {lo} and {hi}."}), 400
        try:
            before = db.fetch_days()
            db.set_setting("fetch_days", days, auth.current_user()["username"])
            result = _fetch_settings()
        except Exception as e:
            log.exception("Saving the fetch settings failed")
            return jsonify({"error": str(e)}), 500
        log.info("Developer %s set the fetch window to %d days (was %d).",
                 auth.current_user()["username"], days, before)
        message = f"Saved: the fetch window is now the last {days} days ({result['start']} to {result['end']})."
        if days < before:
            message += f" Rows dated before {result['start']} are deleted at the next fetch or Archive."
        elif days > before:
            message += " Click Fetch Data to load the longer window now."
        result["message"] = message
        return jsonify(result)

    @app.post("/api/developer/fetch-data")
    @auth.roles_required("developer")
    def developer_fetch_data():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        lock_state = {"held": True}

        def release_lock():
            if lock_state["held"]:
                lock_state["held"] = False
                _sync_action_lock.release()

        def event(name, payload):
            return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

        @stream_with_context
        def stream():
            process = None
            try:
                log.info("Developer started the ESSL data fetch.")
                yield event("log", {"message": "Starting ESSL data fetch..."})
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-u",
                        "-c",
                        "import data_fetch; data_fetch.run(retain_progress=True)",
                    ],
                    cwd=str(Path(__file__).resolve().parent),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
                if process.stdout is None:
                    raise RuntimeError("Could not read data-fetch output.")
                for line in process.stdout:
                    yield event("log", {"message": line.rstrip()})
                return_code = process.wait()
                if return_code:
                    yield event("done", {
                        "ok": False,
                        "message": f"Fetch failed (exit code {return_code}). Click Fetch Data again to retry remaining locations.",
                    })
                    return

                yield event("log", {"message": "Refreshing the dashboard from Neon..."})
                rows, branches = neon_sync.sync()
                _bump_version()
                progress_file = Path(__file__).resolve().with_name(".data_fetch_progress.json")
                progress_file.unlink(missing_ok=True)
                yield event("log", {
                    "message": f"Dashboard refreshed: {rows} rows across {branches} branches."
                })
                yield event("done", {"ok": True, "message": "ESSL data stored in Neon."})
            except GeneratorExit:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait()
                raise
            except Exception as e:
                log.exception("Developer data fetch failed")
                yield event("done", {"ok": False, "message": str(e)})
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait()
                release_lock()

        response = Response(stream(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })
        response.call_on_close(release_lock)
        return response

    @app.get("/api/sync")
    @auth.roles_required("developer", "admin")          # re-reads Neon
    def sync_now():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        try:
            rows, branches = neon_sync.sync()
            _bump_version()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual sync failed")
            return jsonify({"error": str(e)})
        finally:
            _sync_action_lock.release()

    return app


app = create_app()
scheduler = start_scheduler()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=True, use_reloader=False)