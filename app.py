"""Attendance Monitor - Flask backend (Google Sheets storage).

API
  GET /api/branches           -> ["KANNUR", ...]
  GET /api/data?branch=NAME   -> [{d, code, name, inT, outT, dur}, ...]
  GET /api/sync/status        -> {running, last_run, last_kind, last_ok, last_error,
                                  rows, branches, next_full_sync}

Background
  * SyncWorker thread:
      - refreshes the dashboard cache every SYNC_INTERVAL_MINUTES
      - runs the full sync daily at SYNC_HOUR:SYNC_MINUTE (default 04:00)
  * DailyPipelineWorker thread:
      - daily at PIPELINE_HOUR:PIPELINE_MINUTE (default 16:00)
        1) archive_today()   2) data_fetch (after the archive has finished)
"""
import logging
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

import sheets_sync
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance")

BASE_DIR = Path(__file__).resolve().parent


class SyncWorker(threading.Thread):
    """Daemon thread:
       * refreshes the dashboard cache every SYNC_INTERVAL_MINUTES
       * runs the full sync every day at SYNC_HOUR:SYNC_MINUTE
    """

    def __init__(self, interval_minutes, hour, minute, tz_name):
        super().__init__(name="sync-worker", daemon=True)
        self.interval = timedelta(minutes=interval_minutes) if interval_minutes > 0 else None
        self.hour, self.minute = hour, minute
        self.tz = ZoneInfo(tz_name)
        self._stop_evt = threading.Event()
        self._run_lock = threading.Lock()      # no overlapping syncs
        self._state_lock = threading.Lock()
        self.status = {
            "running": False, "last_run": None, "last_kind": None, "last_ok": None,
            "last_error": None, "rows": None, "branches": None, "next_full_sync": None,
        }

    # ---- public API ----
    def stop(self):
        self._stop_evt.set()

    def get_status(self):
        with self._state_lock:
            return dict(self.status)

    # ---- helpers ----
    def _next_daily(self, now):
        t = now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        return t if t > now else t + timedelta(days=1)

    # ---- thread body ----
    def run(self):
        now = datetime.now(self.tz)
        next_full = self._next_daily(now)
        next_refresh = now                      # warm the cache immediately
        self._set(next_full_sync=next_full.isoformat(timespec="minutes"))
        log.info("SyncWorker started (refresh=%s, full sync daily at %02d:%02d %s)",
                 self.interval, self.hour, self.minute, self.tz.key)

        while not self._stop_evt.is_set():
            now = datetime.now(self.tz)

            if now >= next_full:                # also fires late if the PC was asleep
                self._do_full_sync()
                now = datetime.now(self.tz)
                next_full = self._next_daily(now)
                next_refresh = now + self.interval if self.interval else None
                self._set(next_full_sync=next_full.isoformat(timespec="minutes"))
            elif next_refresh and now >= next_refresh:
                self._do_refresh()
                next_refresh = datetime.now(self.tz) + self.interval

            targets = [t for t in (next_full, next_refresh) if t]
            wait = max((min(targets) - datetime.now(self.tz)).total_seconds(), 1)
            self._stop_evt.wait(wait)

    def _do_refresh(self):
        with self._run_lock:
            self._set(running=True)
            try:
                sheets_sync.refresh_cache()
                self._finish("refresh", True)
            except Exception as e:
                log.exception("Cache refresh failed")
                self._finish("refresh", False, str(e))

    def _do_full_sync(self):
        with self._run_lock:
            self._set(running=True)
            try:
                rows, branches = sheets_sync.sync()
                self._finish("full", True, rows=rows, branches=branches)
                log.info("Daily full sync done: %s rows, %s branches", rows, branches)
            except Exception as e:
                log.exception("Daily full sync failed")
                self._finish("full", False, str(e))

    def _finish(self, kind, ok, error=None, **extra):
        self._set(running=False, last_kind=kind, last_ok=ok, last_error=error,
                  last_run=datetime.now(self.tz).isoformat(timespec="seconds"), **extra)

    def _set(self, **kw):
        with self._state_lock:
            self.status.update(kw)


class DailyPipelineWorker(threading.Thread):
    """Every day at hour:minute:
         1) sheets_sync.archive_today()
         2) data_fetch (run in a fresh Python process, only after step 1 is done)
    """

    def __init__(self, hour, minute, tz_name):
        super().__init__(name="pipeline-worker", daemon=True)
        self.hour, self.minute = hour, minute
        self.tz = ZoneInfo(tz_name)
        self._stop_evt = threading.Event()

    def stop(self):
        self._stop_evt.set()

    def _next_run(self, now):
        t = now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        return t if t > now else t + timedelta(days=1)

    def run(self):
        next_run = self._next_run(datetime.now(self.tz))
        log.info("PipelineWorker: next run at %s", next_run.isoformat(timespec="minutes"))
        while not self._stop_evt.is_set():
            wait = (next_run - datetime.now(self.tz)).total_seconds()
            if wait > 0:
                self._stop_evt.wait(min(wait, 60))   # wake often so PC sleep can't skip the run
                continue
            self._run_pipeline()
            next_run = self._next_run(datetime.now(self.tz))
            log.info("PipelineWorker: next run at %s", next_run.isoformat(timespec="minutes"))

    def _run_pipeline(self):
        # Step 1: archive
        try:
            log.info("Pipeline step 1/2: archive_today")
            sheets_sync.archive_today()
            log.info("Archive finished")
        except Exception:
            log.exception("Archive failed")          # still continue to data fetch

        # Step 2: data_fetch.py, unchanged, in its own process
        try:
            log.info("Pipeline step 2/2: data_fetch")
            result = subprocess.run(
                [sys.executable, "-c", "import data_fetch; data_fetch.run()"],
                cwd=str(BASE_DIR),
                capture_output=True,
                text=True,
                timeout=3 * 60 * 60,                 # safety limit: 3 hours
            )
            if result.stdout:
                log.info("data_fetch output:\n%s", result.stdout[-3000:])
            if result.returncode != 0:
                log.error("Data fetch failed (exit %s):\n%s",
                          result.returncode, (result.stderr or "")[-3000:])
            else:
                log.info("Data fetch finished")
        except subprocess.TimeoutExpired:
            log.error("Data fetch timed out")
        except Exception:
            log.exception("Data fetch failed")


sync_worker = SyncWorker(
    Config.SYNC_INTERVAL_MINUTES,
    getattr(Config, "SYNC_HOUR", 4),
    getattr(Config, "SYNC_MINUTE", 0),
    Config.TIMEZONE,
)

pipeline_worker = DailyPipelineWorker(
    getattr(Config, "PIPELINE_HOUR", 16),
    getattr(Config, "PIPELINE_MINUTE", 0),
    Config.TIMEZONE,
)


def create_app():
    app = Flask(__name__)
    CORS(app, resources={r"/api/*": {"origins": Config.CORS_ORIGINS}})

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/branches")
    def branches():
        try:
            return jsonify(sheets_sync.get_branches())
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/data")
    def data():
        branch = request.args.get("branch", "")
        try:
            return jsonify(sheets_sync.get_branch_data(branch))
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/sync/status")
    def sync_status():
        return jsonify(sync_worker.get_status())

    return app

app = create_app()
sync_worker.start()
pipeline_worker.start()

if __name__ == "__main__":
    # use_reloader=False so the threads are not started twice
    app.run(host="0.0.0.0", port=Config.PORT, debug=True, use_reloader=False)