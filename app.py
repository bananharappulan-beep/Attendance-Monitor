"""Attendance Monitor - Flask backend (Google Sheets storage).

API
  GET /api/branches           -> ["KANNUR", ...]
  GET /api/data?branch=NAME   -> [{d, code, name, inT, outT, dur}, ...]
  GET /api/sync               -> {"rows": N, "branches": M}
                                 (re-read source sheet + back-fill P/H/A matrix in the output sheet)

Scheduler
  * every day at ARCHIVE_HOUR:ARCHIVE_MINUTE (default 23:00, Asia/Kolkata):
        today's P/H/A column is written into each branch worksheet
  * every SYNC_INTERVAL_MINUTES: dashboard cache refresh (does not write to the output sheet)
"""
import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

import sheets_sync
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance")


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

    @app.get("/api/sync")
    def sync_now():
        try:
            rows, branches = sheets_sync.sync()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual sync failed")
            return jsonify({"error": str(e)})

    return app


def start_scheduler():
    scheduler = BackgroundScheduler(daemon=True, timezone=Config.TIMEZONE)

    # 1) Daily archive -> today's column in each branch worksheet
    def archive_job():
        try:
            sheets_sync.archive_today()
        except Exception:
            log.exception("Daily archive failed")

    scheduler.add_job(
        archive_job,
        CronTrigger(hour=Config.ARCHIVE_HOUR, minute=Config.ARCHIVE_MINUTE,
                    timezone=Config.TIMEZONE),
        id="daily_archive",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,   # still runs if the PC was busy/asleep up to 1 h late
    )

    # 2) Dashboard cache refresh only (does NOT write to the output sheet)
    if Config.SYNC_INTERVAL_MINUTES > 0:
        def refresh_job():
            try:
                sheets_sync.refresh_cache()
            except Exception:
                log.exception("Cache refresh failed")

        scheduler.add_job(
            refresh_job,
            "interval",
            minutes=Config.SYNC_INTERVAL_MINUTES,
            next_run_time=datetime.now() + timedelta(seconds=5),
            max_instances=1,
            coalesce=True,
        )

    scheduler.start()
    log.info("Daily archive scheduled for %02d:%02d (%s)",
             Config.ARCHIVE_HOUR, Config.ARCHIVE_MINUTE, Config.TIMEZONE)
    return scheduler


app = create_app()
start_scheduler()

if __name__ == "__main__":
    # use_reloader=False so the scheduler is not started twice
    app.run(host="0.0.0.0", port=Config.PORT, debug=True, use_reloader=False)