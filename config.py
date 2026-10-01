import os
from pathlib import Path

from dotenv import load_dotenv

# Always read the .env that sits next to this file (not whatever folder the server was started
# from), and let it override any stale/empty variable already set in the Windows environment.
ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(ENV_FILE, override=True)


def _get(name, default=""):
    return os.getenv(name, default).strip()


class Config:
    PORT = int(_get("PORT", "8080"))

    GOOGLE_CREDENTIALS = _get("GOOGLE_CREDENTIALS", "/path/to/service-account.json")

    # Source: raw punch data (one tab per branch). Read only.
    SHEET_ID = _get("SHEET_ID", "1MkAWVc_f5TOA1y96PJolQ4wCAu2shLKVPrpjMGvRll0")
    # Optional second source for Head Office branches. Read only.
    CORE_OFFICE_SHEET_ID = _get("CORE_OFFICE_SHEET_ID")
    # Output: P/H/A matrix (one worksheet per branch). Read + write.
    OUTPUT_SHEET_ID = _get("OUTPUT_SHEET_ID")

    SKIP_TABS = [t.strip() for t in _get("SKIP_TABS").split(",") if t.strip()]

    # How often the dashboard cache is refreshed from the source sheet (minutes, 0 = off).
    # This does NOT write to the output sheet.
    SYNC_INTERVAL_MINUTES = float(_get("SYNC_INTERVAL_MINUTES", "5"))

    # Daily archive time (24h clock) and timezone
    ARCHIVE_HOUR = int(_get("ARCHIVE_HOUR", "4"))
    ARCHIVE_MINUTE = int(_get("ARCHIVE_MINUTE", "0"))
    TIMEZONE = _get("TIMEZONE", "Asia/Kolkata")

    CORS_ORIGINS = _get("CORS_ORIGINS", "*")

    ENV_FILE_PATH = str(ENV_FILE)
    ENV_FILE_FOUND = ENV_FILE.exists()