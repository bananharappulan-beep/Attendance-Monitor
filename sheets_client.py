"""Thread-local Google Sheets clients and serialized, retryable API access."""
import json
import logging
import ssl
import threading
import time
from pathlib import Path

import gspread
import requests
from google.oauth2 import service_account

from config import Config

log = logging.getLogger("attendance.sheets")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
_SSL_ERRORS = (ssl.SSLError, requests.exceptions.SSLError)
SHEETS_LOCK = threading.RLock()
_thread_state = threading.local()


def _credentials():
    raw = Config.GOOGLE_CREDENTIALS.strip()
    if not raw:
        raise RuntimeError(
            "GOOGLE_CREDENTIALS is empty. Set it to a local JSON path or the raw JSON content."
        )

    if raw.startswith("{"):
        info = json.loads(raw)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)

    path = Path(raw)
    if not path.is_absolute():
        path = (Path(__file__).resolve().parent / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Google service account file not found: {path}")
    return service_account.Credentials.from_service_account_file(str(path), scopes=SCOPES)


def get_client():
    """Return this thread's authorized gspread client."""
    client = getattr(_thread_state, "client", None)
    if client is None:
        credentials = _credentials()
        client = gspread.authorize(credentials)
        _thread_state.client = client
    return client


def _is_retryable(error):
    if isinstance(error, gspread.exceptions.APIError):
        response = getattr(error, "response", None)
        status = getattr(response, "status_code", None)
        return status == 429 or (status is not None and 500 <= status <= 599)
    return isinstance(
        error,
        (ssl.SSLError, OSError, requests.exceptions.ConnectionError),
    )


def with_retry(fn, tries=3, delay=1):
    """Run an operation, retrying transient Sheets/network failures."""
    if tries < 1:
        raise ValueError("tries must be at least 1")

    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Exception as error:
            if not _is_retryable(error) or attempt == tries:
                log.exception("Google Sheets operation failed")
                raise

            if isinstance(error, _SSL_ERRORS):
                _thread_state.client = None
                try:
                    get_client()
                except Exception:
                    log.exception("Failed to rebuild the thread-local Google Sheets client")
                    raise

            log.warning(
                "Transient Google Sheets failure; retrying attempt %d/%d",
                attempt + 1,
                tries,
                exc_info=True,
            )
            time.sleep(delay)
