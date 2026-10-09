"""ESSL -> Neon.

For every ESSL location this downloads the Daily Attendance Report for the last FETCH_DAYS days
(default 40, ending today), then REPLACES that location's Neon table with the fresh rows in one
transaction. Finally every table is cleaned of rows older than the window. Run it daily:

    python data_fetch.py
"""
import json
import logging
import os
import re
from datetime import timedelta
from pathlib import Path

import pandas as pd
from playwright.sync_api import sync_playwright

import db
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance.data_fetch")

BASE_DIR = Path(__file__).resolve().parent

URL      = os.environ.get("ESSL_URL", "http://www.esslcloud.com/OASIS/")
USER     = os.environ.get("ESSL_USER", "essl")
PASS     = os.environ.get("ESSL_PASS", "essl")
HEADLESS = os.environ.get("HEADLESS", "1") == "1"

LOCATION_MAP = db.LOCATION_MAP          # ESSL location name -> branch tab (-> Neon table)
PROGRESS_FILE = BASE_DIR / ".data_fetch_progress.json"


# ---------------------------------------------------------------- progress (resume after failure)
def _save_progress(window, remaining, fetch_complete=False):
    state = {
        "window": window,
        "remaining": remaining,
        "fetch_complete": fetch_complete,
    }
    temporary = PROGRESS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state), encoding="utf-8")
    os.replace(temporary, PROGRESS_FILE)


def _load_progress(window):
    """-> (locations still to fetch, resuming?)  A new day = a new window = start over."""
    if not PROGRESS_FILE.exists():
        return list(LOCATION_MAP), False
    try:
        state = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read fetch progress file: {error}") from error

    if state.get("window") != window:
        return list(LOCATION_MAP), False
    if state.get("fetch_complete") is True:
        return [], True

    remaining = state.get("remaining")
    if not isinstance(remaining, list) or any(
        location not in LOCATION_MAP for location in remaining
    ):
        raise RuntimeError("Fetch progress file contains an invalid remaining-location list.")
    if not remaining:
        raise RuntimeError("Fetch progress file has no locations but is not marked complete.")
    return list(dict.fromkeys(remaining)), True


def _windows(start, end, chunk_days):
    """Split start..end into pieces of at most chunk_days (0 = one piece)."""
    if chunk_days <= 0:
        return [(start, end)]
    pieces, current = [], start
    while current <= end:
        stop = min(end, current + timedelta(days=chunk_days - 1))
        pieces.append((current, stop))
        current = stop + timedelta(days=1)
    return pieces


# ---------------------------------------------------------------- ESSL browser steps
def open_report_form(page):
    page.get_by_text("Reports", exact=True).first.hover()
    page.wait_for_timeout(1500)
    item = page.locator("td.easyMenuItemContentCell",
                        has_text=re.compile(r"^\s*Daily Attendance Report\s*$")).first
    item.evaluate("el => el.click()")
    page.wait_for_timeout(4000)
    frame = page
    for f in page.frames:
        if f.locator("text=Generate Report").count() > 0:
            frame = f
    return frame


def tick(frame, text):
    """Tick a checkbox by its label text (does nothing if already ticked)."""
    try:
        frame.get_by_label(text).first.check(timeout=3000)
    except Exception:
        frame.get_by_text(text).first.click()
    frame.wait_for_timeout(1000)


def select_location(frame, loc):
    selects = frame.locator("select")
    for i in range(selects.count()):
        options = [o.strip() for o in selects.nth(i).locator("option").all_inner_texts()]
        for opt in options:
            if opt.lower() == loc.lower():
                selects.nth(i).select_option(label=opt)
                return opt
    raise RuntimeError(f"Location '{loc}' not found in ESSL dropdown")


def _login_error_details(page):
    try:
        title = page.title()
    except Exception:
        title = "unavailable"

    try:
        body_text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        body_text = ""

    error_lines = []
    for line in body_text.splitlines():
        line = line.strip()
        if not line or not re.search(
            r"\b(error|invalid|incorrect|failed|failure|session|password|username|login)\b",
            line,
            flags=re.IGNORECASE,
        ):
            continue
        for secret in (USER, PASS):
            if len(secret) >= 3:
                line = re.sub(re.escape(secret), "[redacted]", line, flags=re.IGNORECASE)
        error_lines.append(line[:300])
        if len(error_lines) == 5:
            break

    details = [f"URL: {page.url}", f"Title: {title}"]
    if error_lines:
        details.append("Visible error text: " + " | ".join(error_lines))
    else:
        details.append("No visible error text was found.")
    return "; ".join(details)


def download_for_location(page, loc, path, start, end):
    """Download the Daily Attendance Report (CSV) for `loc` from `start` to `end` (inclusive)."""
    frame = open_report_form(page)

    # 1. Tick Filter Employee and pick the location first
    tick(frame, "Filter Employee")
    chosen = select_location(frame, loc)
    print("Location selected:", chosen)

    # 2. Tick Recalculate Attendance
    tick(frame, "Recalculate Attendance")

    # 3. From / To dates and CSV Export last (so nothing resets them)
    sel = frame.locator("select")
    labels = [
        (1, str(start.day)), (2, start.strftime("%b")), (3, str(start.year)),
        (4, str(end.day)),   (5, end.strftime("%b")),   (6, str(end.year)),
    ]
    for i, lab in labels:
        try:
            sel.nth(i).select_option(label=lab)
        except Exception as e:
            print(f"Dropdown {i} skipped ({lab}):", str(e)[:80])
    frame.locator("select:has(option:text-is('CSV Export'))").first.select_option(label="CSV Export")

    # 4. Generate and catch the download
    try:
        with page.expect_download(timeout=180000) as d:
            frame.get_by_text("Generate Report").first.click()
    except Exception:
        err = ""
        try:
            body = frame.locator("body").inner_text()
            m = re.search(r"Error:.*", body)
            err = m.group(0) if m else ""
        except Exception:
            pass
        raise RuntimeError(f"No download. Form message: {err or 'none'}")
    d.value.save_as(path)
    print(f"Downloaded {start} to {end}:", path)


def _read_csv(path):
    return pd.read_csv(path, dtype=str, keep_default_na=False,
                       encoding="utf-8-sig", encoding_errors="replace")


# ---------------------------------------------------------------- Neon
def push_to_neon(tab_name, df):
    """Replace the branch table with the fetched rows. Returns the number of rows stored."""
    rows, stats = db.prepare_rows(df)
    table = db.table_name(tab_name)
    if stats["bad_date"] or stats["no_code"] or stats["duplicates"]:
        print(
            f"{tab_name}: skipped {stats['bad_date']} row(s) without a valid date, "
            f"{stats['no_code']} without an employee code; {stats['duplicates']} duplicate(s) merged."
        )
    if not rows:
        # Never wipe a table because of an empty / unreadable report.
        print(f"{tab_name}: ESSL returned no usable rows - existing data in '{table}' kept.")
        return 0
    with db.session() as conn:
        removed = db.replace_rows(conn, table, rows)
    print(f"Neon updated: {table} ({removed} old rows replaced by {len(rows)} new rows)")
    return len(rows)


def cleanup(start):
    """Daily cleanup: remove everything older than the window from every branch table."""
    with db.session() as conn:
        removed = db.cleanup_old(conn, start)
    print(f"Cleanup: {removed} row(s) older than {start} deleted.")
    return removed


# ---------------------------------------------------------------- main job
def run(retain_progress=False):
    start, end = db.fetch_window()
    window = f"{start.isoformat()}..{end.isoformat()}"
    pieces = _windows(start, end, Config.FETCH_CHUNK_DAYS)

    pending_locations, resuming = _load_progress(window)
    if resuming and not pending_locations:
        print(f"Fetch for {window} is complete; nothing more to do.")
        return
    if resuming:
        print(
            f"Resuming fetch for {window}; {len(pending_locations)} location(s) remain: "
            + ", ".join(pending_locations)
        )
    else:
        print(f"Starting fetch for {window} ({(end - start).days + 1} days); "
              f"{len(pending_locations)} locations.")

    # Fail fast (before opening ESSL) if Neon is unreachable or a table is missing.
    with db.session() as conn:
        missing = db.missing_tables(conn)
    if missing:
        raise RuntimeError(
            "These Neon tables do not exist: " + ", ".join(missing)
            + ". Run attendance_tables.sql in the Neon SQL Editor first."
        )
    _save_progress(window, pending_locations)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS, args=["--no-sandbox"])
        page = browser.new_page(accept_downloads=True, viewport={"width": 1600, "height": 900})

        try:
            page.goto(URL, timeout=60000)
            page.wait_for_selector("input[name='StaffloginDialog$txt_LoginName']", timeout=30000)
            page.fill("input[name='StaffloginDialog$txt_LoginName']", USER)
            page.fill("input[name='StaffloginDialog$Txt_Password']", PASS)
            page.click("[name='StaffloginDialog$Btn_Ok']")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(2000)
            login_form = page.locator(
                "input[name='StaffloginDialog$txt_LoginName']"
            )
            if "CustomError" in page.url or login_form.is_visible():
                raise RuntimeError(
                    "ESSL login failed or the session was rejected. "
                    + _login_error_details(page)
                )
            print("Login done. Page:", page.url)

            failed_locations = []
            for essl_loc in list(pending_locations):
                tab = LOCATION_MAP[essl_loc]
                safe = re.sub(r"[^A-Za-z0-9]+", "_", essl_loc)
                print(f"Fetching {essl_loc} -> {db.table_name(tab)}...", flush=True)
                frames = []
                try:
                    for piece_start, piece_end in pieces:
                        path = BASE_DIR / f"report_{safe}.csv"
                        try:
                            download_for_location(page, essl_loc, str(path), piece_start, piece_end)
                            frames.append(_read_csv(path))
                        finally:
                            path.unlink(missing_ok=True)
                            print("CSV removed:", path.name)
                    df = pd.concat(frames, ignore_index=True)
                    print(f"{essl_loc} -> {tab}: {len(df)} rows for {window}")
                    push_to_neon(tab, df)
                    pending_locations.remove(essl_loc)
                    _save_progress(window, pending_locations)
                    print(f"Completed {essl_loc}.", flush=True)
                except Exception:
                    failed_locations.append(essl_loc)
                    log.exception("Failed to fetch or store ESSL report for %s", essl_loc)
                    print(f"FAILED {essl_loc}; it will be retried.", flush=True)
            if failed_locations:
                _save_progress(window, failed_locations)
                cleanup(start)
                raise RuntimeError(
                    "ESSL data fetch failed for locations: "
                    + ", ".join(failed_locations)
                )
        finally:
            browser.close()

    cleanup(start)
    _save_progress(window, [], fetch_complete=True)
    print(f"Fetch for {window} completed successfully.", flush=True)
    if not retain_progress:
        PROGRESS_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    run()