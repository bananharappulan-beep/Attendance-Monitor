"""Neon (PostgreSQL) storage for the dashboard.

    ESSL --data_fetch.py--> Neon: one table per branch, last 40 days, replaced every day
    Dashboard <------------ this module (reads Neon, caches rows in memory)

The P/H/A matrix is no longer saved anywhere. It is calculated from the stored punch rows every
time it is needed, so it can never be out of date. Rows look like

    {"d": "2026-10-06", "code": "M123", "name": "BANA", "inT": "09:15", "outT": "18:05", "dur": "8:50"}

and the matrix like

    {"dates": ["2026-10-01", ...], "rows": [{"name": ..., "code": ..., "statuses": {"2026-10-01": "P"}}]}
"""
import logging
import re
import threading
import time as _time
from calendar import monthrange
from datetime import date

import db
from config import Config
from db import parse_date, parse_time  # noqa: F401  (re-exported for other modules)

log = logging.getLogger("attendance.sync")

HEADER = "EMPLOYEE NAME"
CODE_HEADER = "EMPLOYEE CODE"
OUTPUT_SKIP_TABS = frozenset({
    "MAGNUS INSITUTE MANJERI",
    "MAGNUS INSTITUTE OF TECHNOLOGY MARTHANDAM",
    "MAGNUS INSTITUTE FCO MANJERI",
    "MAGNUS GROUP MANJERI R&D",
})
PRESENT_MIN = 5 * 60 + 1  # > 5h -> P (durations are calculated to whole minutes)
HALF_MIN = 4 * 60      # 4h through 5h -> H
HALF_MAX = 5 * 60      # 5h inclusive (keep in sync with app.js)
ABSENT_AFTER = 14 * 60 # Punch-in after 2 PM -> A

_sync_lock = threading.RLock()
_cache_lock = threading.RLock()
_cache = None          # {branch: [row, ...]} read from Neon
_cache_loaded_at = 0.0


# ---------- small helpers ----------
def _branch_name(tab, company, core_office=False):
    if core_office:
        return tab
    business = re.sub(r"\s+", " ", (company or "").strip())
    if not business or business.casefold() in {"magnus", "default"}:
        return tab
    if tab.casefold().startswith(business.casefold() + " "):
        return tab
    return f"{business.upper()} {tab.strip().upper()}".strip()


def _employee_key(name):
    return "".join(char for char in str(name or "").casefold() if char.isalnum())


def _employee_identity(code, name):
    code = str(code or "").strip()
    if code:
        return f"code:{code.casefold()}"
    return f"name:{_employee_key(name)}"


def _label(d):
    """date -> '1/9/2026' (no zero padding)."""
    return f"{d.day}/{d.month}/{d.year}"


def _cell(row, i):
    if i < 0 or i >= len(row) or row[i] is None:
        return ""
    return str(row[i])


def _minutes(hhmm):
    if not hhmm:
        return None
    h, m = hhmm.split(":")[:2]
    return int(h) * 60 + int(m)


def _duration_minutes(value):
    """Parse a duration such as '7:30' or '7:30:00' into minutes."""
    match = re.fullmatch(r"\s*(\d+):([0-5]?\d)(?::([0-5]?\d))?\s*", str(value or ""))
    if not match:
        return None
    hours, minutes = int(match.group(1)), int(match.group(2))
    return hours * 60 + minutes


def work_minutes(row):
    """Use punch times when complete; otherwise use the stored duration."""
    if not row:
        return 0
    in_minutes, out_minutes = _minutes(row.get("inT", "")), _minutes(row.get("outT", ""))
    if out_minutes is not None:
        if out_minutes < 12 * 60 and (out_minutes < in_minutes if in_minutes is not None else out_minutes < 8 * 60):
            out_minutes += 12 * 60
        return out_minutes - in_minutes if in_minutes is not None and out_minutes > in_minutes else 0
    if in_minutes is not None:
        return _duration_minutes(row.get("dur")) or 0
    return 0


def status_for(row):
    """P / H / A from punch times or, without punch-out, the stored duration."""
    in_minutes = _minutes(row.get("inT", "")) if row else None
    if in_minutes is not None and in_minutes > ABSENT_AFTER:
        return "A"
    work = work_minutes(row)
    return "P" if work >= PRESENT_MIN else "H" if HALF_MIN <= work <= HALF_MAX else "A"


# ---------- read the rows from Neon ----------
def fetch_source():
    """-> {branch: [{d, code, name, inT, outT, dur}, ...]}  read from every Neon branch table.

    The branch label is built per row from the table (tab) and the Company column, exactly like
    before: e.g. table 'manjeri' + company 'ALIMS' -> 'ALIMS MANJERI'."""
    out = {}
    with db.session() as conn:
        present = db.existing_tables(conn)
        for tab in db.TABS:
            table = db.table_name(tab)
            if table not in present:
                log.warning("Neon table '%s' does not exist - skipped.", table)
                continue
            core_office = tab in db.CORE_OFFICE_TABS
            for day, code, name, company, t_in, t_out, duration in db.load_rows(conn, table):
                name = (name or "").strip()
                if not name or day is None:
                    continue
                code = (code or "").strip()
                branch = _branch_name(tab, company, core_office)
                rows = out.setdefault(branch, {})
                rows[(day.isoformat(), _employee_identity(code, name))] = {
                    "d": day.isoformat(),
                    "code": code,
                    "name": name,
                    "inT": t_in.strftime("%H:%M") if t_in else "",
                    "outT": t_out.strftime("%H:%M") if t_out else "",
                    "dur": db.format_interval(duration),
                }
    return {
        branch: sorted(rows.values(), key=lambda x: (x["d"], x["name"]))
        for branch, rows in out.items() if rows
    }


# ---------- build the matrix ----------
def build_matrix(rows, branch=None, all_source=None):
    """rows = stored rows of one branch.
    Returns [header] + one line per employee:  CODE | NAME | P/H/A for every day of every month
    that has data (blank where the day has no attendance records at all)."""
    by_key = {
        (row["d"], _employee_identity(row.get("code"), row["name"])): row
        for row in rows
    }
    src_dates = {r["d"] for r in rows}            # dates that have attendance records
    employees = {}
    for row in rows:
        identity = _employee_identity(row.get("code"), row["name"])
        employee = employees.setdefault(
            identity, {"code": "", "name": row["name"], "statuses": {}}
        )
        if row.get("code"):
            employee["code"] = str(row["code"]).strip()
    if all_source is not None:
        for employee in employees.values():
            if not employee["code"]:
                employee["code"] = _resolve_employee_code(
                    employee["name"], branch or "", all_source
                )
    for d in src_dates:
        for identity, employee in employees.items():
            employee["statuses"][d] = status_for(by_key.get((d, identity)))

    months = {(int(d[:4]), int(d[5:7])) for d in src_dates}
    all_dates = [date(y, m, day) for y, m in sorted(months)
                 for day in range(1, monthrange(y, m)[1] + 1)]

    header = [CODE_HEADER, HEADER] + [_label(d) for d in all_dates]
    body = [
        [employee["code"], employee["name"]]
        + [employee["statuses"].get(day.isoformat(), "") for day in all_dates]
        for employee in sorted(
            employees.values(),
            key=lambda item: (item["name"].casefold(), item["code"].casefold()),
        )
    ]
    return [header] + body


def _resolve_employee_code(name, branch, source):
    branch_key = _employee_key(branch)
    exact_branch, related_branches = [], []
    all_rows = []
    for source_branch, source_rows in source.items():
        entries = [(row.get("name", ""), str(row.get("code") or "").strip())
                   for row in source_rows if row.get("code")]
        all_rows.extend(entries)
        if source_branch.casefold() == branch.casefold():
            exact_branch.extend(entries)
        elif _employee_key(source_branch).endswith(branch_key):
            related_branches.extend(entries)

    target = str(name or "").strip()
    name_matchers = (
        lambda candidate: candidate.strip() == target,
        lambda candidate: candidate.strip().casefold() == target.casefold(),
        lambda candidate: _employee_key(candidate) == _employee_key(target),
    )
    for candidates in (exact_branch, related_branches, all_rows):
        for matches_name in name_matchers:
            codes = {code for candidate, code in candidates if matches_name(candidate)}
            if codes:
                return next(iter(codes)) if len(codes) == 1 else ""
    return ""


def _parse_saved_matrix(branch, values, source):
    if not values:
        return {"dates": [], "rows": []}

    header = [str(cell).strip().upper() for cell in values[0]]
    name_column = header.index(HEADER) if HEADER in header else 0
    code_column = header.index(CODE_HEADER) if CODE_HEADER in header else -1
    date_columns = []
    for index, value in enumerate(values[0]):
        if index in (name_column, code_column):
            continue
        parsed = parse_date(str(value))
        if parsed:
            date_columns.append((parsed.isoformat(), index))

    rows = []
    for row in values[1:]:
        name = _cell(row, name_column).strip()
        if not name:
            continue
        code = _cell(row, code_column).strip() if code_column >= 0 else ""
        if not code:
            code = _resolve_employee_code(name, branch, source)
        statuses = {}
        for iso_date, index in date_columns:
            value = _cell(row, index).strip().upper()
            if value in ("P", "H", "A"):
                statuses[iso_date] = value
        rows.append({"name": name, "code": code, "statuses": statuses})

    return {"dates": [d for d, _ in date_columns], "rows": rows}


def _matrix(branch, source):
    values = build_matrix(source.get(branch, []), branch=branch, all_source=source)
    return _parse_saved_matrix(branch, values, source)


# ---------- cache ----------
def _set_cache(source):
    global _cache, _cache_loaded_at
    with _cache_lock:
        _cache = source
        _cache_loaded_at = _time.monotonic()


def _source():
    """Rows of every branch; re-read from Neon when empty or older than CACHE_TTL_SECONDS."""
    with _cache_lock:
        ttl = Config.CACHE_TTL_SECONDS
        stale = ttl > 0 and _time.monotonic() - _cache_loaded_at > ttl
        if _cache is None or stale:
            _set_cache(fetch_source())
        return _cache


# ---------- public API used by the Flask routes ----------
def sync(only_dates=None):
    """Re-read Neon and refresh the dashboard cache. Returns (rows_read, branches).
    (only_dates is accepted for backward compatibility and ignored.)"""
    with _sync_lock:
        source = fetch_source()
        _set_cache(source)
    rows = sum(len(v) for v in source.values())
    log.info("Loaded %d rows, %d branches from Neon", rows, len(source))
    return rows, len(source)


refresh_cache = sync


def cleanup_old():
    """Delete rows older than the fetch window from every table, then refresh the cache.
    Returns the number of rows deleted."""
    start, _ = db.fetch_window()
    with db.session() as conn:
        removed = db.cleanup_old(conn, start)
    log.info("Cleanup removed %d rows older than %s", removed, start)
    sync()
    return removed


def get_branches():
    return sorted(_source())


def get_branch_data(branch):
    return [dict(r) for r in _source().get(branch, [])]


def get_all():
    """{branch: rows} - used by report.py."""
    return {branch: [dict(r) for r in rows] for branch, rows in _source().items()}


def get_saved_matrices(branches):
    """P/H/A matrices of several branches, calculated from the stored rows."""
    source = _source()
    return {branch: _matrix(branch, source) for branch in dict.fromkeys(branches)}


def get_saved_matrix(branch):
    return get_saved_matrices([branch])[branch]


def get_current_matrix(branch):
    return get_saved_matrix(branch)
