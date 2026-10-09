"""Neon (PostgreSQL) access layer.

One table per ESSL location (created by attendance_tables.sql), all with the same columns:

    attendance_date, employee_code, employee_name, company, department, category, designation,
    grade, team, shift, in_time, out_time, duration, late_by, early_by, status,
    punch_records, overtime        (+ id, created_at)

Used by data_fetch.py (writes) and neon_sync.py (reads).
"""
import logging
import re
import time as _time
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values

from config import Config

log = logging.getLogger("attendance.db")

# ESSL location name  ->  branch tab name (the Neon table is derived from the tab name)
LOCATION_MAP = {
    "Manjeri Branch": "MANJERI",
    "KASARGOD":       "KASARGOD",
    "Kannur":         "KANNUR",
    "KINASSERI":      "KOZHIKODE",
    "KUTTIYADI":      "KUTTIYADI",
    "TIRUR":          "TIRUR",
    "PALAKKAD":       "PALAKKAD",
    "THRISSUR":       "THRISSUR",
    "Alapuzha":       "ALAPPUZHA",
    "KOLLAM":         "KOLLAM",
    "Attingal":       "TRIVANDRUM",
    "MARTHANDAM":     "MARTHANDAM",
    "NAGPUR":         "NAGPUR",
    "Hyderabad":      "HYDERABAD",
    "BANGALORE":      "BANGALORE",
    "MERCHX MJR":     "MERCHX MANJERI",
    "MANJERI HU":     "HU MANJERI",
    "FCO MANJERI":    "FCO MANJERI",
    "HEAD OFFICE":    "HEAD OFFICE",
    "Manjeri fr":     "MANJERI FR",
    "MANJERI R&D":    "MANJERI R&D",
}
TABS = list(LOCATION_MAP.values())

# These tabs are shown under their plain name (HEAD OFFICE, MANJERI R&D, ...) instead of
# "<COMPANY> <TAB>" - the same as the old separate Head Office source sheet.
CORE_OFFICE_TABS = frozenset({"HEAD OFFICE", "MANJERI R&D", "MANJERI FR", "FCO MANJERI"})


def table_name(tab):
    """'MANJERI R&D' -> 'manjeri_r_d', 'HEAD OFFICE' -> 'head_office' (matches attendance_tables.sql)."""
    return re.sub(r"[^a-z0-9]+", "_", tab.lower()).strip("_")


# ---------------------------------------------------------------- connection
# ---------------------------------------------------------------- saved settings
# Small key/value table so a developer can change settings (e.g. the number of days to fetch) from the
# web app. It lives in Neon, so it survives redeploys and is shared by the web app and data_fetch.py.
def get_setting(key, default=None):
    """Saved value of `key`, or `default` if it was never saved. Real errors (Neon down, ...) are raised
    on purpose: the cleanup deletes rows, so it must never fall back to a wrong value silently."""
    try:
        with session() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM app_settings WHERE key = %s", (key,))
                row = cur.fetchone()
    except psycopg2.errors.UndefinedTable:          # nothing was ever saved: the table does not exist yet
        return default
    return row[0] if row else default


def set_setting(key, value, updated_by=""):
    with session() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS app_settings ("
                "key text PRIMARY KEY, value text NOT NULL, "
                "updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)"
            )
            cur.execute(
                "INSERT INTO app_settings (key, value, updated_by) VALUES (%s, %s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "
                "updated_at = now(), updated_by = EXCLUDED.updated_by",
                (key, str(value), updated_by or None),
            )


def fetch_days():
    """Days in the fetch window: the value saved from the web app, else FETCH_DAYS from .env."""
    try:
        days = int(get_setting("fetch_days"))
    except (TypeError, ValueError):
        return Config.FETCH_DAYS
    return min(max(days, Config.FETCH_DAYS_MIN), Config.FETCH_DAYS_MAX)


def fetch_window():
    """-> (start_date, end_date), both inclusive. fetch_days() days ending today (in Config.TIMEZONE)."""
    today = datetime.now(ZoneInfo(Config.TIMEZONE)).date()
    end = today - timedelta(days=Config.FETCH_END_OFFSET_DAYS)
    start = end - timedelta(days=fetch_days() - 1)
    return start, end


def _connect(retries=4, delay=3):
    if not Config.DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is empty. Put the Neon connection string in the .env file "
            f"({getattr(Config, 'ENV_FILE_PATH', '.env')})."
        )
    last = None
    for attempt in range(1, retries + 1):
        try:
            return psycopg2.connect(Config.DATABASE_URL, connect_timeout=30)
        except psycopg2.OperationalError as error:      # Neon may still be waking up
            last = error
            log.warning("Neon connection failed (attempt %d/%d): %s", attempt, retries, str(error).strip())
            if attempt < retries:
                _time.sleep(delay * attempt)
    raise RuntimeError(f"Could not connect to Neon: {str(last).strip()}") from last


@contextmanager
def session():
    """Open a connection, commit on success, roll back on error, always close."""
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------- parsing helpers
ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")
DMY = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})")
FALLBACK_FORMATS = (
    "%d %b %Y", "%b %d, %Y", "%d-%b-%Y", "%d/%b/%Y", "%d-%B-%Y", "%d %B %Y",
    "%B %d, %Y", "%Y/%m/%d", "%a, %d %b %Y",
)
HM = re.compile(r"(\d{1,2}):(\d{2})(?::(\d{2}))?")
DURATION = re.compile(r"\s*(\d+):([0-5]?\d)(?::([0-5]?\d))?\s*")


def parse_date(s):
    """Accepts yyyy-mm-dd, dd-mm-yyyy (- / .), '5 Sep 2026', '05-Sep-2026', 'Sep 5, 2026'."""
    s = (s or "").strip()
    if isinstance(s, str):
        try:
            m = ISO.match(s)
            if m:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            m = DMY.match(s)
            if m:
                return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    for candidate in (s, s.split(" ")[0] if s else s):
        for fmt in FALLBACK_FORMATS:
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                pass
    return None


def parse_time(s):
    """'09:15', '9:15 AM', '5:05 pm', '09:15:30' -> datetime.time. Blank or '--:--' -> None."""
    s = s or ""
    m = HM.search(s)
    if not m:
        return None
    h, minute, sec = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    low = s.lower()
    if "pm" in low and h < 12:
        h += 12
    if "am" in low and h == 12:
        h = 0
    if h > 23 or minute > 59 or sec > 59:
        return None
    return time(h, minute, sec)


def parse_interval(s):
    """'7:30' / '07:30:00' -> timedelta. Blank, '-', '--:--' -> None."""
    m = DURATION.fullmatch(s or "")
    if not m:
        return None
    return timedelta(hours=int(m.group(1)), minutes=int(m.group(2)), seconds=int(m.group(3) or 0))


def format_interval(value):
    """timedelta -> 'H:MM' (same text the dashboard read from the sheet). None -> ''."""
    if value is None:
        return ""
    minutes = int(value.total_seconds() // 60)
    return f"{minutes // 60}:{minutes % 60:02d}"


# ---------------------------------------------------------------- ESSL CSV -> rows
COLUMNS = [
    "attendance_date", "employee_code", "employee_name", "company", "department", "category",
    "designation", "grade", "team", "shift", "in_time", "out_time", "duration", "late_by",
    "early_by", "status", "punch_records", "overtime",
]
TIME_COLUMNS = {"in_time", "out_time"}
INTERVAL_COLUMNS = {"duration", "late_by", "early_by", "overtime"}
MAX_LENGTH = {          # VARCHAR sizes in attendance_tables.sql
    "employee_code": 30, "employee_name": 150, "company": 150, "department": 100,
    "category": 100, "designation": 100, "grade": 50, "team": 100, "shift": 50, "status": 30,
}
# ESSL CSV header (lower-case, single spaces)  ->  table column
HEADER_ALIASES = {
    "date": "attendance_date",
    "employee code": "employee_code",
    "employee name": "employee_name",
    "company": "company",
    "department": "department",
    "category": "category",
    "designation": "designation",
    "degination": "designation",        # ESSL's own spelling
    "grade": "grade",
    "team": "team",
    "shift": "shift",
    "in time": "in_time",
    "out time": "out_time",
    "duration": "duration",
    "late by": "late_by",
    "early by": "early_by",
    "status": "status",
    "punch records": "punch_records",
    "overtime": "overtime",
}


def _norm_header(header):
    return re.sub(r"\s+", " ", str(header).replace("﻿", "").strip().lower())


def prepare_rows(df):
    """ESSL DataFrame (all text) -> ([row tuples in COLUMNS order], stats).

    Rows without a valid date or employee code are skipped; a repeated (date, code) keeps the
    last occurrence, because the table has UNIQUE (attendance_date, employee_code)."""
    source_col = {}
    for header in df.columns:
        column = HEADER_ALIASES.get(_norm_header(header))
        if column and column not in source_col:
            source_col[column] = header
    missing = [c for c in ("attendance_date", "employee_code") if c not in source_col]
    if missing:
        raise ValueError(
            f"ESSL report is missing column(s) {missing}. Columns found: {list(df.columns)}"
        )

    rows = {}
    stats = {"read": len(df), "bad_date": 0, "no_code": 0, "duplicates": 0}
    for record in df.to_dict("records"):
        def text(column):
            header = source_col.get(column)
            return str(record.get(header, "")).strip() if header is not None else ""

        day = parse_date(text("attendance_date"))
        if day is None:
            stats["bad_date"] += 1
            continue
        code = text("employee_code")[: MAX_LENGTH["employee_code"]]
        if not code:
            stats["no_code"] += 1
            continue

        values = []
        for column in COLUMNS:
            if column == "attendance_date":
                values.append(day)
            elif column == "employee_code":
                values.append(code)
            elif column in TIME_COLUMNS:
                values.append(parse_time(text(column)))
            elif column in INTERVAL_COLUMNS:
                values.append(parse_interval(text(column)))
            elif column == "punch_records":
                values.append(text(column) or None)
            else:
                values.append(text(column)[: MAX_LENGTH[column]] or None)
        key = (day, code)
        if key in rows:
            stats["duplicates"] += 1
        rows[key] = tuple(values)
    stats["kept"] = len(rows)
    return list(rows.values()), stats


# ---------------------------------------------------------------- queries
def existing_tables(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
        return {row[0] for row in cur.fetchall()}


def missing_tables(conn):
    present = existing_tables(conn)
    return [table_name(tab) for tab in TABS if table_name(tab) not in present]


def replace_rows(conn, table, rows):
    """Atomically swap a table's contents for `rows` (one transaction: delete all, insert all).
    Nothing is visible half-way, and a failure leaves the old data untouched."""
    with conn.cursor() as cur:
        cur.execute(sql.SQL("DELETE FROM {}").format(sql.Identifier(table)))
        removed = cur.rowcount
        statement = sql.SQL("INSERT INTO {} ({}) VALUES %s").format(
            sql.Identifier(table),
            sql.SQL(", ").join(sql.Identifier(column) for column in COLUMNS),
        ).as_string(conn)
        execute_values(cur, statement, rows, page_size=1000)
    return removed


def cleanup_old(conn, keep_from):
    """Daily cleanup: delete every row dated before `keep_from` in all branch tables."""
    present = existing_tables(conn)
    removed = 0
    with conn.cursor() as cur:
        for tab in TABS:
            table = table_name(tab)
            if table not in present:
                continue
            cur.execute(
                sql.SQL("DELETE FROM {} WHERE attendance_date < %s").format(sql.Identifier(table)),
                (keep_from,),
            )
            removed += cur.rowcount
    return removed


def load_rows(conn, table):
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL(
                "SELECT attendance_date, employee_code, employee_name, company, "
                "in_time, out_time, duration FROM {} ORDER BY attendance_date, employee_name"
            ).format(sql.Identifier(table))
        )
        return cur.fetchall()