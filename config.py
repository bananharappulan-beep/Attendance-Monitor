import os
from pathlib import Path

from dotenv import load_dotenv

# Always read the .env that sits next to this file (not whatever folder the server was started
# from), and let it override any stale/empty variable already set in the environment.
ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(ENV_FILE, override=True)


def _get(name, default=""):
    return os.getenv(name, default).strip()


class Config:
    PORT = int(_get("PORT", "8080"))

    # ---- Neon (PostgreSQL) -------------------------------------------------------------
    # Neon console -> Connect -> copy the connection string, e.g.
    #   postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
    DATABASE_URL = _get("DATABASE_URL")

    # ---- ESSL fetch window -------------------------------------------------------------
    # The window ends on (today - FETCH_END_OFFSET_DAYS) and covers FETCH_DAYS days in total,
    # e.g. today = 6 Oct, FETCH_DAYS = 40 -> 28 Aug .. 6 Oct.
    # FETCH_DAYS is only the DEFAULT. A developer can change the number of days from the web app
    # (Sync -> Fetch Days); that choice is stored in Neon and wins over this value.
    FETCH_DAYS = max(1, int(_get("FETCH_DAYS", "40")))
    FETCH_DAYS_MIN = 7        # allowed range for the value set from the web app
    FETCH_DAYS_MAX = 180
    FETCH_END_OFFSET_DAYS = max(0, int(_get("FETCH_END_OFFSET_DAYS", "0")))
    # 0 = ask ESSL for the whole window in ONE report. If ESSL ever rejects a long range,
    # set e.g. FETCH_CHUNK_DAYS=10 and the window is fetched in 10-day pieces instead.
    FETCH_CHUNK_DAYS = max(0, int(_get("FETCH_CHUNK_DAYS", "0")))

    # ---- Daily automatic fetch (runs inside the web app) --------------------------------
    AUTO_FETCH = _get("AUTO_FETCH", "1") == "1"
    FETCH_HOUR = int(_get("FETCH_HOUR", "4"))
    FETCH_MINUTE = int(_get("FETCH_MINUTE", "0"))
    TIMEZONE = _get("TIMEZONE", "Asia/Kolkata")

    # How long the dashboard keeps the Neon rows in memory before re-reading (seconds, 0 = never).
    CACHE_TTL_SECONDS = max(0, int(_get("CACHE_TTL_SECONDS", "300")))

    CORS_ORIGINS = _get("CORS_ORIGINS", "*")

    ENV_FILE_PATH = str(ENV_FILE)
    ENV_FILE_FOUND = ENV_FILE.exists()