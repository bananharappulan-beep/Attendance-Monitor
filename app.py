"""Attendance Monitor - Flask backend (Google Sheets storage).

API
  GET /api/branches           -> ["KANNUR", ...]
  GET /api/data?branch=NAME   -> [{d, code, name, inT, outT, dur}, ...]
  GET /api/sync               -> {"rows": N, "branches": M}
                                 (re-read source sheet + back-fill P/H/A matrix in the output sheet)

Scheduler
    * every day at ARCHIVE_HOUR:ARCHIVE_MINUTE (default 04:00, Asia/Kolkata):
                yesterday's P/H/A column is archived, then data_fetch.py refreshes source data
  * every SYNC_INTERVAL_MINUTES: dashboard cache refresh (does not write to the output sheet)
"""
import gzip
import logging
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from flask import Flask, jsonify, redirect, render_template, request
from flask_cors import CORS

import auth
import sheets_sync
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance")

from inaactive import INACTIVE


def _compress_json_response(response):
    """Gzip sizeable JSON API responses when the client supports it."""
    if (
        not response.mimetype == "application/json"
        or response.status_code < 200
        or response.status_code in (204, 304)
        or response.headers.get("Content-Encoding")
        or response.direct_passthrough
    ):
        return response

    body = response.get_data()
    if len(body) < 1024:
        return response

    response.vary.add("Accept-Encoding")
    if request.accept_encodings.best_match(["gzip"]) != "gzip":
        return response

    response.set_data(gzip.compress(body, compresslevel=5, mtime=0))
    response.headers["Content-Encoding"] = "gzip"
    response.headers.pop("ETag", None)
    return response


def create_app():
    app = Flask(__name__)
    CORS(app, resources={r"/api/*": {"origins": Config.CORS_ORIGINS}})
    app.after_request(_compress_json_response)

    auth.init_app(app)          # login, roles, users.json, /login, /api/me, /api/users ...

    @app.get("/")
    def index():
        if not auth.current_user():
            return redirect("/login")
        return render_template("index.html")

    def _deny(msg="You do not have access to this report."):
        return jsonify({"error": msg}), 403

    @app.get("/api/branches")
    @auth.login_required
    def branches():
        try:
            return jsonify(auth.filter_branches(auth.current_user(), sheets_sync.get_branches()))
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/data")
    @auth.login_required
    def data():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "daily", "summary") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            rows = sheets_sync.get_branch_data(branch)
            if not auth.can_change_date(user):
                rows = auth.latest_date_only(rows)      # date locked -> latest day only
            return jsonify(rows)
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.post("/api/refresh")
    @auth.login_required
    def refresh_data():
        try:
            rows, branches = sheets_sync.refresh_cache()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual data refresh failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/matrix")
    @auth.login_required
    def matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "matrix") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            result = sheets_sync.get_saved_matrix(branch)
            if not auth.can_change_date(user):
                result = auth.limit_matrix_to_latest_month(result)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/sync")
    @auth.roles_required("developer", "admin")          # writes to the output sheet
    def sync_now():
        try:
            rows, branches = sheets_sync.sync()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual sync failed")
            return jsonify({"error": str(e)})

    @app.route("/api/inactive", methods=["GET"])
    @auth.login_required
    def inactive():
        user = auth.current_user()
        if not auth.can_view_tab(user, "inactive"):
            return _deny()
        try:
            start_date = request.args.get("start_date") if auth.can_change_date(user) else None
            inactive_data = INACTIVE.get_inactive(
                start_date=start_date,
                n_days=request.args.get("n_days", default=2, type=int),
            )
            return jsonify({
                branch: frame.to_dict(orient="records")
                for branch, frame in inactive_data.items()
                if auth.branch_allowed(user, branch)
            })
        except Exception as e:
            log.exception("Inactive fetch failed")
            return jsonify({"error": str(e)}), 500

    return app


def start_scheduler():
    scheduler = BackgroundScheduler(daemon=True, timezone=Config.TIMEZONE)

    # APScheduler runs this sequence on its background executor.
    def daily_pipeline_job():
        try:
            log.info("Daily pipeline step 1/3: archive yesterday")
            sheets_sync.archive_yesterday()
        except Exception:
            log.exception("Daily archive failed; data fetch skipped")
            return

        try:
            log.info("Daily pipeline step 2/3: fetch ESSL data")
            result = subprocess.run(
                [sys.executable, "-c", "import data_fetch; data_fetch.run()"],
                cwd=str(Path(__file__).resolve().parent),
                capture_output=True,
                text=True,
                timeout=3 * 60 * 60,
            )
            if result.stdout:
                log.info("data_fetch output:\n%s", result.stdout[-3000:])
            if result.returncode:
                log.error("Data fetch failed (exit %s):\n%s",
                          result.returncode, (result.stderr or "")[-3000:])
                return
            log.info("Data fetch finished")
        except subprocess.TimeoutExpired:
            log.error("Data fetch timed out")
            return
        except Exception:
            log.exception("Data fetch failed")
            return

        try:
            log.info("Daily pipeline step 3/3: update status matrix")
            rows, branches = sheets_sync.sync()
            log.info("Status matrix updated after ESSL fetch: %d rows, %d branches",
                     rows, branches)
        except Exception:
            log.exception("Status matrix update after ESSL fetch failed")

    scheduler.add_job(
        daily_pipeline_job,
        CronTrigger(hour=Config.ARCHIVE_HOUR, minute=Config.ARCHIVE_MINUTE,
                    timezone=Config.TIMEZONE),
        id="daily_archive_and_fetch",
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
    log.info("Daily archive/fetch pipeline scheduled for %02d:%02d (%s)",
             Config.ARCHIVE_HOUR, Config.ARCHIVE_MINUTE, Config.TIMEZONE)
    return scheduler


app = create_app()
start_scheduler()

if __name__ == "__main__":
    # use_reloader=False so the scheduler is not started twice
    app.run(host="0.0.0.0", port=Config.PORT, debug=True, use_reloader=False)