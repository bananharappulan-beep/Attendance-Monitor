"""Google Sheets storage.

SOURCE sheet  (SHEET_ID)        : raw punches, one tab per branch (read only)
OUTPUT sheet  (OUTPUT_SHEET_ID) : saved P/H/A matrix, one worksheet per branch, e.g.

    EMPLOYEE NAME | 1/9/2026 | 2/9/2026 | ... | 30/9/2026
    BANA          | P        | A        |     |

The header holds EVERY day of the month. At 11:00 PM each day only that day's column is
filled in (archive_today). All other columns are kept exactly as they are.
The manual "Sync Sheet" button back-fills every date found in the source sheet.
"""
import json
import logging
import re
import threading
from calendar import monthrange
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from google.oauth2 import service_account
from googleapiclient.discovery import build

from config import Config

log = logging.getLogger("attendance.sync")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
HEADER = "EMPLOYEE NAME"
PRESENT_MIN = 5 * 60 + 1  # > 5h -> P (durations are calculated to whole minutes)
HALF_MIN = 4 * 60      # 4h through 5h -> H
HALF_MAX = 5 * 60      # 5h inclusive (keep in sync with app.js)
ABSENT_AFTER = 14 * 60 # Punch-in after 2 PM -> A

_lock = threading.RLock()
_service = None
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


# ---------- Google API ----------
def _credentials():
    raw = Config.GOOGLE_CREDENTIALS.strip()
    if not raw:
        raise RuntimeError("GOOGLE_CREDENTIALS is empty. Set it to a local JSON path or the raw JSON content.")

    if raw.startswith("{"):
        info = json.loads(raw)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)

    path = Path(raw)
    if not path.is_absolute():
        path = (Path(__file__).resolve().parent / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Google service account file not found: {path}")
    return service_account.Credentials.from_service_account_file(str(path), scopes=SCOPES)


def _sheets():
    global _service
    if _service is None:
        _service = build("sheets", "v4", credentials=_credentials(), cache_discovery=False)
    return _service


# ---------- read the SOURCE sheet ----------
def fetch_source():
    """-> {branch: [{d, code, name, inT, outT}, ...]}  (one request for all tabs)."""
    api = _sheets().spreadsheets()
    out = {}
    source_ids = dict.fromkeys(
        sheet_id for sheet_id in (Config.SHEET_ID, Config.CORE_OFFICE_SHEET_ID) if sheet_id
    )
    for sheet_id in source_ids:
        meta = api.get(
            spreadsheetId=sheet_id, fields="sheets.properties.title"
        ).execute()
        tabs = [
            s["properties"]["title"]
            for s in meta.get("sheets", [])
            if s["properties"]["title"] not in Config.SKIP_TABS
        ]
        if not tabs:
            continue
        res = api.values().batchGet(
            spreadsheetId=sheet_id,
            ranges=[_quote(t) for t in tabs],
            valueRenderOption="FORMATTED_VALUE",
        ).execute()

        for tab, vr in zip(tabs, res.get("valueRanges", [])):
            values = vr.get("values", [])
            if len(values) < 2:
                continue
            header = [str(h).strip().lower() for h in values[0]]

            def idx(name):
                return header.index(name) if name in header else -1

            i_date, i_code, i_name = idx("date"), idx("employee code"), idx("employee name")
            i_in, i_out = idx("in time"), idx("out time")
            i_duration = idx("duration") if idx("duration") >= 0 else 12

            rows = out.setdefault(tab, {})
            for r in values[1:]:
                name = _cell(r, i_name).strip()
                d = parse_date(_cell(r, i_date))
                if not name or d is None:
                    continue
                t_in, t_out = parse_time(_cell(r, i_in)), parse_time(_cell(r, i_out))
                rows[(d.isoformat(), name)] = {
                    "d": d.isoformat(),
                    "code": _cell(r, i_code),
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
    """Saved worksheet values -> ({name: {iso_date: 'P'|'H'|'A'}}, {dates found in header})."""
    if not values:
        return {}, set()
    dates = [parse_date(str(c)) for c in values[0][1:]]
    header_dates = {d for d in dates if d}
    saved = {}
    for row in values[1:]:
        name = str(row[0]).strip() if row else ""
        if not name:
            continue
        per_day = saved.setdefault(name, {})
        for d, cell in zip(dates, row[1:]):
            c = str(cell).strip().upper()
            if d and c in ("P", "H", "A"):
                per_day[d.isoformat()] = c
    return saved, header_dates


def build_matrix(rows, saved, header_dates, only_dates=None):
    """rows = source rows of one branch, saved = already saved statuses,
    header_dates = dates already in the worksheet header.

    Header = EMPLOYEE NAME + every day of every month involved.
    Only the dates in `only_dates` (None = all dates in the source) are (re)calculated;
    every other saved value is kept unchanged."""
    by_key = {(r["d"], r["name"]): r for r in rows}
    src_dates = {r["d"] for r in rows}            # dates that have attendance records
    if only_dates is not None:
        src_dates &= set(only_dates)
    names = set(saved) | {r["name"] for r in rows}
    status = {n: dict(saved.get(n, {})) for n in names}
    for d in src_dates:
        for n in names:                           # employee missing on a date with data -> A
            status[n][d] = status_for(by_key.get((d, n)))

    months = {(d.year, d.month) for d in header_dates}
    months |= {(int(d[:4]), int(d[5:7])) for d in src_dates}
    months |= {(int(d[:4]), int(d[5:7])) for s in status.values() for d in s}
    all_dates = [date(y, m, day) for y, m in sorted(months)
                 for day in range(1, monthrange(y, m)[1] + 1)]

    header = [HEADER] + [_label(d) for d in all_dates]
    body = [[n] + [status[n].get(d.isoformat(), "") for d in all_dates]
            for n in sorted(names, key=str.casefold)]
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

    api = _sheets().spreadsheets()
    meta = api.get(
        spreadsheetId=out_id, fields="sheets.properties(sheetId,title,gridProperties)"
    ).execute()
    tabs = {s["properties"]["title"]: s["properties"] for s in meta.get("sheets", [])}

    # what is already saved (one request)
    have = [b for b in source if b in tabs]
    saved, headers = {}, {}
    if have:
        res = api.values().batchGet(
            spreadsheetId=out_id,
            ranges=[_quote(b) for b in have],
            valueRenderOption="FORMATTED_VALUE",
        ).execute()
        for b, vr in zip(have, res.get("valueRanges", [])):
            saved[b], headers[b] = parse_existing(vr.get("values", []))

    matrices = {
        b: build_matrix(rows, saved.get(b, {}), headers.get(b, set()), only_dates)
        for b, rows in source.items()
    }

    # create missing worksheets / grow small ones (one request)
    requests = []
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
        api.batchUpdate(spreadsheetId=out_id, body={"requests": requests}).execute()

    # write everything (one request). RAW keeps '28/9/2026' as plain text.
    api.values().batchUpdate(
        spreadsheetId=out_id,
        body={"valueInputOption": "RAW",
              "data": [{"range": _quote(b) + "!A1", "values": m} for b, m in matrices.items()]},
    ).execute()


# ---------- public API used by the Flask routes / scheduler ----------
def sync(only_dates=None):
    """Read the source sheet, refresh the dashboard cache, save the matrices.
    only_dates=None -> archive every date found in the source (manual 'Sync Sheet' back-fill).
    Returns (rows_read, branches_saved)."""
    global _cache
    with _lock:
        source = fetch_source()
        _cache = source
        if source:
            save_matrices(source, only_dates)
        rows = sum(len(v) for v in source.values())
        log.info("Synced %d rows, %d branches", rows, len(source))
        return rows, len(source)


def archive_today():
    """Runs at 11 PM: write ONLY today's column into every branch worksheet."""
    today = datetime.now(ZoneInfo(Config.TIMEZONE)).date().isoformat()
    log.info("Archiving %s", today)
    return sync(only_dates={today})


def refresh_cache():
    """Frequent job: keeps the dashboard fresh without touching the output sheet."""
    global _cache
    with _lock:
        _cache = fetch_source()


def _source():
    global _cache
    with _lock:
        if _cache is None:
            _cache = fetch_source()
        return _cache


def get_branches():
    return sorted(_source())


def get_branch_data(branch):
    return [dict(r) for r in _source().get(branch, [])]