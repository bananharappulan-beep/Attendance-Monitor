import json
import logging
import os
import re
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import gspread
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from playwright.sync_api import sync_playwright

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance.data_fetch")

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

URL      = os.environ.get("ESSL_URL", "http://www.esslcloud.com/OASIS/")
USER     = os.environ.get("ESSL_USER", "essl")
PASS     = os.environ.get("ESSL_PASS", "essl")
HEADLESS = os.environ.get("HEADLESS", "1") == "1"

SHEET_ID = os.environ["SHEET_ID"]

GOOGLE_CREDS = os.environ.get("GOOGLE_CREDS") or os.environ.get(
    "GOOGLE_CREDENTIALS", "service-account.json"
)
GOOGLE_CREDS_INFO = None
if GOOGLE_CREDS.lstrip().startswith("{"):
    GOOGLE_CREDS_INFO = json.loads(GOOGLE_CREDS)
else:
    if not os.path.isabs(GOOGLE_CREDS):
        GOOGLE_CREDS = str(BASE_DIR / GOOGLE_CREDS)
    if not os.path.exists(GOOGLE_CREDS):
        raise FileNotFoundError(
            "Service-account credentials are missing. Set GOOGLE_CREDS or "
            "GOOGLE_CREDENTIALS to the JSON content or path to a JSON file."
        )

# ESSL location name  ->  Google Sheet worksheet name
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

# Report date = yesterday (run on the 30th -> 29th to 29th)
report_day = date.today() - timedelta(days=1)
D, M, Y = str(report_day.day), report_day.strftime("%b"), str(report_day.year)


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


def download_for_location(page, loc, path):
    frame = open_report_form(page)

    # 1. Tick Filter Employee and pick the location first
    tick(frame, "Filter Employee")
    chosen = select_location(frame, loc)
    print("Location selected:", chosen)

    # 2. Tick Recalculate Attendance
    tick(frame, "Recalculate Attendance")

    # 3. Dates and CSV Export last (so nothing resets them)
    sel = frame.locator("select")
    for i, lab in [(1, D), (2, M), (3, Y), (4, D), (5, M), (6, Y)]:
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
    print("Downloaded:", path)


def push_to_sheet(spreadsheet, tab_name, df):
    try:
        ws = spreadsheet.worksheet(tab_name)
    except gspread.WorksheetNotFound:
        ws = spreadsheet.add_worksheet(title=tab_name, rows=1000, cols=40)
        print("Created new tab:", tab_name)
    df = df.fillna("").astype(str)
    values = [df.columns.tolist()] + df.values.tolist()
    ws.clear()                                   # delete existing data first
    ws.update(range_name="A1", values=values)    # then add the new data
    print(f"Sheet updated: {tab_name} ({len(df)} rows)")

def run():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = (
        Credentials.from_service_account_info(GOOGLE_CREDS_INFO, scopes=scopes)
        if GOOGLE_CREDS_INFO is not None
        else Credentials.from_service_account_file(GOOGLE_CREDS, scopes=scopes)
    )
    spreadsheet = gspread.authorize(creds).open_by_key(SHEET_ID)

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
            for essl_loc, sheet_tab in LOCATION_MAP.items():
                safe = re.sub(r"[^A-Za-z0-9]+", "_", essl_loc)
                path = BASE_DIR / f"report_{safe}.csv"
                try:
                    download_for_location(page, essl_loc, str(path))
                    df = pd.read_csv(path)
                    print(f"{essl_loc} -> {sheet_tab}: {len(df)} rows for {report_day}")
                    push_to_sheet(spreadsheet, sheet_tab, df)
                except Exception:
                    failed_locations.append(essl_loc)
                    log.exception("Failed to fetch or upload ESSL report for %s", essl_loc)
                finally:
                    path.unlink(missing_ok=True)
                    print("CSV removed:", path.name)
            if failed_locations:
                raise RuntimeError(
                    "ESSL data fetch failed for locations: "
                    + ", ".join(failed_locations)
                )
        finally:
            browser.close()