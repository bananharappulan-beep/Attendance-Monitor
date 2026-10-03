"""Attendance Monitor - Flask backend (Google Sheets storage).

API
  GET /api/branches           -> ["KANNUR", ...]
  GET /api/data?branch=NAME   -> [{d, code, name, inT, outT, dur}, ...]
  GET /api/sync               -> {"rows": N, "branches": M}
                                 (re-read source sheet + back-fill P/H/A matrix in the output sheet)

Archive and ESSL fetch are started manually by a developer from the Sync sidebar.
"""
import gzip
import json
import logging
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, redirect, render_template, request, stream_with_context
from flask_cors import CORS

import auth
import sheets_sync
from config import Config

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("attendance")
_sync_action_lock = threading.Lock()

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

    def _empty_matrix_for_branch(branch):
        skipped = {name.casefold() for name in sheets_sync.OUTPUT_SKIP_TABS}
        return {"dates": [], "rows": []} if branch.casefold() in skipped else None

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
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            result = sheets_sync.get_current_matrix(branch)
            if not auth.can_change_date(user):
                result = auth.limit_matrix_to_latest_month(result)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)})

    @app.get("/api/summary-matrix")
    @auth.login_required
    def summary_matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if not auth.can_view_tab(user, "summary") or not auth.branch_allowed(user, branch):
            return _deny()
        try:
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            matrix = sheets_sync.get_saved_matrix(branch)
            latest_status_date = max(
                (
                    day
                    for row in matrix.get("rows", [])
                    for day, status in row.get("statuses", {}).items()
                    if status in ("P", "H", "A")
                ),
                default="",
            )
            if not latest_status_date:
                return jsonify({"dates": [], "rows": []})
            target = datetime.strptime(latest_status_date, "%Y-%m-%d").date()
            dates = [(target - timedelta(days=offset)).isoformat() for offset in range(3, -1, -1)]
            return jsonify({
                "dates": dates,
                "rows": [
                    {
                        "name": row.get("name", ""),
                        "code": row.get("code", ""),
                        "statuses": {
                            day: row.get("statuses", {}).get(day, "")
                            for day in dates
                        },
                    }
                    for row in matrix.get("rows", [])
                ],
            })
        except Exception as e:
            log.exception("Summary matrix fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/attendance-matrix")
    @auth.login_required
    def attendance_matrix():
        user = auth.current_user()
        branch = request.args.get("branch", "")
        if (
            not auth.can_view_tab(user, "daily", "summary", "inactive")
            or not auth.branch_allowed(user, branch)
        ):
            return _deny()
        try:
            empty_matrix = _empty_matrix_for_branch(branch)
            if empty_matrix is not None:
                return jsonify(empty_matrix)
            return jsonify(sheets_sync.get_saved_matrix(branch))
        except Exception as e:
            log.exception("Attendance matrix fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.get("/api/attendance-matrices")
    @auth.login_required
    def attendance_matrices():
        user = auth.current_user()
        branches = list(dict.fromkeys(request.args.getlist("branch")))
        if not auth.can_view_tab(user, "summary") or any(
            not auth.branch_allowed(user, branch) for branch in branches
        ):
            return _deny()
        try:
            matrices = {}
            output_branches = []
            for branch in branches:
                empty_matrix = _empty_matrix_for_branch(branch)
                if empty_matrix is None:
                    output_branches.append(branch)
                else:
                    matrices[branch] = empty_matrix
            matrices.update(sheets_sync.get_saved_matrices(output_branches))
            return jsonify(matrices)
        except Exception as e:
            log.exception("Attendance matrices fetch failed")
            return jsonify({"error": str(e)}), 500

    @app.post("/api/developer/archive")
    @auth.roles_required("developer")
    def developer_archive():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        try:
            sheets_sync.archive_yesterday()
            return jsonify({"ok": True, "message": "Yesterday's attendance was archived."})
        except Exception as e:
            log.exception("Developer archive failed")
            return jsonify({"error": str(e)}), 500
        finally:
            _sync_action_lock.release()

    @app.post("/api/developer/fetch-data")
    @auth.roles_required("developer")
    def developer_fetch_data():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        lock_state = {"held": True}

        def release_lock():
            if lock_state["held"]:
                lock_state["held"] = False
                _sync_action_lock.release()

        def event(name, payload):
            return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

        @stream_with_context
        def stream():
            process = None
            try:
                log.info("Developer started the ESSL data fetch.")
                yield event("log", {"message": "Starting ESSL data fetch..."})
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-u",
                        "-c",
                        "import data_fetch; data_fetch.run(retain_progress=True)",
                    ],
                    cwd=str(Path(__file__).resolve().parent),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
                if process.stdout is None:
                    raise RuntimeError("Could not read data-fetch output.")
                for line in process.stdout:
                    yield event("log", {"message": line.rstrip()})
                return_code = process.wait()
                if return_code:
                    yield event("done", {
                        "ok": False,
                        "message": f"Fetch failed (exit code {return_code}). Click Fetch Data again to retry remaining locations.",
                    })
                    return

                yield event("log", {"message": "Updating the attendance status matrix..."})
                rows, branches = sheets_sync.sync()
                progress_file = Path(__file__).resolve().with_name(".data_fetch_progress.json")
                progress_file.unlink(missing_ok=True)
                yield event("log", {
                    "message": f"Status matrix updated: {rows} rows across {branches} branches."
                })
                yield event("done", {"ok": True, "message": "Data fetch and matrix update completed."})
            except GeneratorExit:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait()
                raise
            except Exception as e:
                log.exception("Developer data fetch failed")
                yield event("done", {"ok": False, "message": str(e)})
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait()
                release_lock()

        response = Response(stream(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })
        response.call_on_close(release_lock)
        return response

    @app.get("/api/sync")
    @auth.roles_required("developer", "admin")          # writes to the output sheet
    def sync_now():
        if not _sync_action_lock.acquire(blocking=False):
            return jsonify({"error": "A sync action is already running."}), 409
        try:
            rows, branches = sheets_sync.sync()
            return jsonify({"rows": rows, "branches": branches})
        except Exception as e:
            log.exception("Manual sync failed")
            return jsonify({"error": str(e)})
        finally:
            _sync_action_lock.release()

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=True, use_reloader=False)