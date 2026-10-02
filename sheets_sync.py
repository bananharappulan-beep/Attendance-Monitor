"""Google Sheets storage.

SOURCE sheet  (SHEET_ID)        : raw punches, one tab per branch (read only)
OUTPUT sheet  (OUTPUT_SHEET_ID) : saved P/H/A matrix, one worksheet per branch, e.g.

    EMPLOYEE CODE | EMPLOYEE NAME | 1/9/2026 | 2/9/2026 | ... | 30/9/2026
    M123          | BANA          | P        | A        |     |

The header holds EVERY day of the month. At 4:00 AM each day only the previous day's column is
filled in (archive_yesterday). All other columns are kept exactly as they are.
The full sync back-fills every date found in the source sheet.
"""
import logging
import re
import threading
from calendar import monthrange
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from config import Config
from sheets_client import SHEETS_LOCK, get_client, with_retry

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
_cache = None          # {branch: [row, ...]} read from the source sheet

HM = re.compile(r"(\d{1,2}):(\d{2})")
ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")
DMY = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})")
FALLBACK_FORMATS = ("%d %b %Y", "%b %d, %Y")


# ---------- parsing helpers ----------
def parse_time(s):
    """'09:15', '9:15 AM', '5:05 pm' -> datetime.time. Blank or '--:--' -> None."""
    m = HM.search(s or "")
    if not m:
        return None
    h, minute = int(m.group(1)), int(m.group(2))
    low = s.lower()
    if "pm" in low and h < 12:
        h += 12
    if "am" in low and h == 12:
        h = 0
    if h > 23 or minute > 59:
        return None
    return time(h, minute)


def parse_date(s):
    """Accepts yyyy-mm-dd, dd-mm-yyyy (- / .), '5 Sep 2026', 'Sep 5, 2026'."""
    s = (s or "").strip()
    try:
        m = ISO.match(s)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = DMY.match(s)
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None
    for fmt in FALLBACK_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _cell(row, i):
    if i < 0 or i >= len(row) or row[i] is None:
        return ""
    return str(row[i])


def _quote(tab):
    return "'" + tab.replace("'", "''") + "'"


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
    """date -> '1/9/2026' (no zero padding, same as the backup file)."""
    return f"{d.day}/{d.month}/{d.year}"


def _minutes(hhmm):
    if not hhmm:
        return None
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _duration_minutes(value):
    """Parse a Sheets duration such as '7:30' or '7:30:00' into minutes."""
    match = re.fullmatch(r"\s*(\d+):([0-5]?\d)(?::([0-5]?\d))?\s*", str(value or ""))
    if not match:
        return None
    hours, minutes = int(match.group(1)), int(match.group(2))
    return hours * 60 + minutes


def work_minutes(row):
    """Use punch times when complete; otherwise use the source duration in column M."""
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
    """P / H / A from punch times or, without punch-out, the source duration."""
    in_minutes = _minutes(row.get("inT", "")) if row else None
    if in_minutes is not None and in_minutes > ABSENT_AFTER:
        return "A"
    work = work_minutes(row)
    return "P" if work >= PRESENT_MIN else "H" if HALF_MIN <= work <= HALF_MAX else "A"


def _sheets_call(operation):
    """Run one gspread operation under the shared lock with transient retries."""
    with SHEETS_LOCK:
        return with_retry(lambda: operation(get_client()))


# ---------- read the SOURCE sheet ----------
def fetch_source():
    """Fetch source rows, retrying transient failures and rebuilding after TLS errors."""
    return _fetch_source_once()


def _fetch_source_once():
    """-> {branch: [{d, code, name, inT, outT}, ...]}  (one request for all tabs)."""
    out = {}
    source_ids = dict.fromkeys(
        sheet_id for sheet_id in (Config.SHEET_ID, Config.CORE_OFFICE_SHEET_ID) if sheet_id
    )
    for sheet_id in source_ids:
        is_core_office = (
            sheet_id == Config.CORE_OFFICE_SHEET_ID
            and sheet_id != Config.SHEET_ID
        )
        meta = _sheets_call(
            lambda client: client.open_by_key(sheet_id).fetch_sheet_metadata(
                params={"fields": "sheets.properties.title"}
            )
        )
        tabs = [
            s["properties"]["title"]
            for s in meta.get("sheets", [])
            if s["properties"]["title"] not in Config.SKIP_TABS
        ]
        if not tabs:
            continue
        res = _sheets_call(
            lambda client: client.open_by_key(sheet_id).values_batch_get(
                ranges=[_quote(tab) for tab in tabs],
                params={"valueRenderOption": "FORMATTED_VALUE"},
            )
        )

        for tab, vr in zip(tabs, res.get("valueRanges", [])):
            values = vr.get("values", [])
            if len(values) < 2:
                continue
            header = [str(h).strip().lower() for h in values[0]]

            def idx(name):
                return header.index(name) if name in header else -1

            i_date, i_code, i_name = idx("date"), idx("employee code"), idx("employee name")
            i_in, i_out = idx("in time"), idx("out time")
            i_company = idx("company")
            i_duration = idx("duration") if idx("duration") >= 0 else 12

            for r in values[1:]:
                name = _cell(r, i_name).strip()
                d = parse_date(_cell(r, i_date))
                if not name or d is None:
                    continue
                branch = _branch_name(tab, _cell(r, i_company), is_core_office)
                rows = out.setdefault(branch, {})
                t_in, t_out = parse_time(_cell(r, i_in)), parse_time(_cell(r, i_out))
                code = _cell(r, i_code).strip()
                rows[(d.isoformat(), _employee_identity(code, name))] = {
                    "d": d.isoformat(),
                    "code": code,
                    "name": name,
                    "inT": t_in.strftime("%H:%M") if t_in else "",
                    "outT": t_out.strftime("%H:%M") if t_out else "",
                    "dur": _cell(r, i_duration).strip(),
                }
    return {
        tab: sorted(rows.values(), key=lambda x: (x["d"], x["name"]))
        for tab, rows in out.items() if rows
    }


# ---------- build / merge the matrix ----------
def parse_existing(values):
    """Saved worksheet values -> ({employee_id: record}, {dates found in header})."""
    if not values:
        return {}, set()
    header = [str(cell).strip().upper() for cell in values[0]]
    name_column = header.index(HEADER) if HEADER in header else 0
    code_column = header.index(CODE_HEADER) if CODE_HEADER in header else -1
    date_columns = [
        (parse_date(str(cell)), index)
        for index, cell in enumerate(values[0])
        if index not in (name_column, code_column)
    ]
    header_dates = {day for day, _ in date_columns if day}
    saved = {}
    for row in values[1:]:
        name = _cell(row, name_column).strip()
        if not name:
            continue
        code = _cell(row, code_column).strip() if code_column >= 0 else ""
        identity = _employee_identity(code, name)
        record = saved.setdefault(
            identity, {"code": code, "name": name, "statuses": {}}
        )
        for day, index in date_columns:
            value = _cell(row, index).strip().upper()
            if day and value in ("P", "H", "A"):
                record["statuses"][day.isoformat()] = value
    return saved, header_dates


def build_matrix(rows, saved, header_dates, only_dates=None, branch=None, all_source=None):
    """rows = source rows of one branch, saved = already saved statuses,
    header_dates = dates already in the worksheet header.

    Header = EMPLOYEE CODE + EMPLOYEE NAME + every day of every month involved.
    Only the dates in `only_dates` (None = all dates in the source) are (re)calculated;
    every other saved value is kept unchanged."""
    by_key = {
        (row["d"], _employee_identity(row.get("code"), row["name"])): row
        for row in rows
    }
    src_dates = {r["d"] for r in rows}            # dates that have attendance records
    if only_dates is not None:
        src_dates &= set(only_dates)
    employees = {
        identity: {
            "code": record.get("code", ""),
            "name": record.get("name", ""),
            "statuses": dict(record.get("statuses", {})),
        }
        for identity, record in saved.items()
    }
    for row in rows:
        identity = _employee_identity(row.get("code"), row["name"])
        employee = employees.setdefault(
            identity, {"code": "", "name": row["name"], "statuses": {}}
        )
        if row.get("code"):
            employee["code"] = str(row["code"]).strip()
        if not employee["name"]:
            employee["name"] = row["name"]
    if all_source is not None:
        for employee in employees.values():
            if not employee["code"]:
                employee["code"] = _resolve_employee_code(
                    employee["name"], branch or "", all_source
                )
    for d in src_dates:
        for identity, employee in employees.items():
            employee["statuses"][d] = status_for(by_key.get((d, identity)))

    months = {(d.year, d.month) for d in header_dates}
    months |= {(int(d[:4]), int(d[5:7])) for d in src_dates}
    months |= {
        (int(d[:4]), int(d[5:7]))
        for employee in employees.values()
        for d in employee["statuses"]
    }
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


# ---------- write the OUTPUT sheet ----------
def save_matrices(source, only_dates=None):
    out_id = Config.OUTPUT_SHEET_ID
    if not out_id or out_id.startswith("PASTE_"):
        raise RuntimeError(
            f"OUTPUT_SHEET_ID is empty or still a placeholder (value read: {out_id!r}). "
            f".env expected at {getattr(Config, 'ENV_FILE_PATH', '?')} "
            f"(file found: {getattr(Config, 'ENV_FILE_FOUND', '?')}). "
            "Open that file and check there is exactly one OUTPUT_SHEET_ID= line with the sheet ID."
        )
    if out_id == Config.SHEET_ID:
        raise RuntimeError("OUTPUT_SHEET_ID must be a different sheet from SHEET_ID.")

    meta = _sheets_call(
        lambda client: client.open_by_key(out_id).fetch_sheet_metadata(
            params={"fields": "sheets.properties(sheetId,title,gridProperties)"}
        )
    )
    tabs = {s["properties"]["title"]: s["properties"] for s in meta.get("sheets", [])}
    all_source = source
    source = {branch: rows for branch, rows in source.items() if branch not in OUTPUT_SKIP_TABS}
    requests = [
        {"deleteSheet": {"sheetId": tabs[branch]["sheetId"]}}
        for branch in OUTPUT_SKIP_TABS if branch in tabs
    ]

    # what is already saved (one request)
    have = [b for b in source if b in tabs]
    saved, headers = {}, {}
    if have:
        res = _sheets_call(
            lambda client: client.open_by_key(out_id).values_batch_get(
                ranges=[_quote(branch) for branch in have],
                params={"valueRenderOption": "FORMATTED_VALUE"},
            )
        )
        for b, vr in zip(have, res.get("valueRanges", [])):
            saved[b], headers[b] = parse_existing(vr.get("values", []))

    matrices = {
        b: build_matrix(
            rows, saved.get(b, {}), headers.get(b, set()), only_dates,
            branch=b, all_source=all_source,
        )
        for b, rows in source.items()
    }

    # create missing worksheets / grow small ones (one request)
    for b, m in matrices.items():
        need_r, need_c = max(len(m), 2), max(len(m[0]), 2)
        props = tabs.get(b)
        if props is None:
            requests.append({"addSheet": {"properties": {
                "title": b,
                "gridProperties": {"rowCount": need_r, "columnCount": need_c,
                                   "frozenRowCount": 1, "frozenColumnCount": 1}}}})
        else:
            g = props.get("gridProperties", {})
            rc, cc = g.get("rowCount", 0), g.get("columnCount", 0)
            if rc < need_r or cc < need_c:
                requests.append({"updateSheetProperties": {
                    "properties": {"sheetId": props["sheetId"],
                                   "gridProperties": {"rowCount": max(rc, need_r),
                                                      "columnCount": max(cc, need_c)}},
                    "fields": "gridProperties(rowCount,columnCount)"}})
    if requests:
        body = {"requests": requests}
        _sheets_call(
            lambda client: client.open_by_key(out_id).batch_update(body=body)
        )

    # write everything (one request). RAW keeps '28/9/2026' as plain text.
    body = {
        "valueInputOption": "RAW",
        "data": [
            {"range": _quote(branch) + "!A1", "values": matrix}
            for branch, matrix in matrices.items()
        ],
    }
    _sheets_call(
        lambda client: client.open_by_key(out_id).values_batch_update(body=body)
    )


# ---------- public API used by the Flask routes / scheduler ----------
def sync(only_dates=None):
    """Read the source sheet, refresh the dashboard cache, save the matrices.
    only_dates=None -> archive every date found in the source (manual 'Sync Sheet' back-fill).
    Returns (rows_read, branches_saved)."""
    global _cache
    with _sync_lock:
        source = fetch_source()
        with _cache_lock:
            _cache = source
        if source:
            save_matrices(source, only_dates)
        rows = sum(len(v) for v in source.values())
        log.info("Synced %d rows, %d branches", rows, len(source))
        return rows, len(source)


def archive_today():
    """Write only today's column into every branch worksheet."""
    today = datetime.now(ZoneInfo(Config.TIMEZONE)).date().isoformat()
    log.info("Archiving %s", today)
    return sync(only_dates={today})


def archive_yesterday():
    """Write only yesterday's column into every branch worksheet."""
    yesterday = datetime.now(ZoneInfo(Config.TIMEZONE)).date() - timedelta(days=1)
    log.info("Archiving %s", yesterday.isoformat())
    return sync(only_dates={yesterday.isoformat()})


def refresh_cache():
    """Frequent job: keeps the dashboard fresh without touching the output sheet."""
    global _cache
    with _sync_lock:
        source = fetch_source()
        with _cache_lock:
            _cache = source
    rows = sum(len(branch_rows) for branch_rows in source.values())
    log.info("Refreshed dashboard cache: %d rows, %d branches", rows, len(source))
    return rows, len(source)


def _source():
    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = fetch_source()
        return _cache


def get_branches():
    return sorted(_source())


def get_branch_data(branch):
    return [dict(r) for r in _source().get(branch, [])]


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


def get_saved_matrices(branches):
    """Read multiple branch matrices from OUTPUT in one Sheets API request."""
    if not Config.OUTPUT_SHEET_ID:
        raise RuntimeError("OUTPUT_SHEET_ID is empty.")
    branches = list(dict.fromkeys(branches))
    if not branches:
        return {}
    result = _sheets_call(
        lambda client: client.open_by_key(Config.OUTPUT_SHEET_ID).values_batch_get(
            ranges=[_quote(branch) for branch in branches],
            params={"valueRenderOption": "FORMATTED_VALUE"},
        )
    )
    source = _source()
    value_ranges = result.get("valueRanges", [])
    matrices = {
        branch: _parse_saved_matrix(branch, value_range.get("values", []), source)
        for branch, value_range in zip(branches, value_ranges)
    }
    return {
        branch: matrices.get(branch, {"dates": [], "rows": []})
        for branch in branches
    }


def get_saved_matrix(branch):
    """Read one branch's saved status matrix from the OUTPUT spreadsheet."""
    return get_saved_matrices([branch])[branch]