# Attendance Monitor (Flask + Neon PostgreSQL)

ESSL -> **Neon** (one table per branch) -> dashboard. Google Sheets is no longer used.

## How the data flows
1. `data_fetch.py` logs in to ESSL and, for each of the 21 locations, downloads the *Daily Attendance
   Report* (CSV) for the **last 40 days ending today**.
2. Each branch table is **replaced** with the fresh rows in one transaction (old rows deleted + new rows
   inserted together, so the dashboard never sees a half-empty table). An empty or unreadable report never
   wipes a table.
3. **Daily cleanup:** after the fetch, every table is trimmed of rows older than the 40-day window.
4. `neon_sync.py` reads the tables for the dashboard. The P/H/A matrix is calculated from the stored punch
   rows (P = more than 5h, H = 4h through 5h, A = less than 4h / no record / punch-in after 14:00), so
   there is no separate output sheet any more.

The job runs automatically every day at `FETCH_HOUR:FETCH_MINUTE` (default 04:00, `TIMEZONE`) while the app
is running, and manually from the developer **Sync** sidebar (Fetch Data = fetch + replace + cleanup;
Archive = cleanup only). It can also be run on its own, e.g. from cron: `python data_fetch.py`.

## Setup
1. In the Neon SQL Editor run `attendance_tables.sql` (click **Run**, not Explain). It creates the 21 tables.
2. `pip install -r requirements.txt` and `playwright install chromium` (the Docker image already has it).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, `ESSL_USER`, `ESSL_PASS`.
4. `python app.py` -> http://localhost:8080. Production: `gunicorn -w 1 -b 0.0.0.0:8080 app:app`
   (keep a single worker so the daily scheduler and in-memory cache run once).

## Fetch window
`FETCH_DAYS=40` and `FETCH_END_OFFSET_DAYS=0` give: from = today - 39 days, to = today.
Example (6 Oct 2026): 28 Aug 2026 .. 6 Oct 2026. Set `FETCH_END_OFFSET_DAYS=1` to end yesterday instead.

## Tables
`kollam, alappuzha, kannur, nagpur, hyderabad, palakkad, trivandrum, manjeri_fr, manjeri, kuttiyadi,
kasargod, marthandam, tirur, head_office, hu_manjeri, merchx_manjeri, kozhikode, thrissur, manjeri_r_d,
bangalore, fco_manjeri` - unique on (`attendance_date`, `employee_code`).

ESSL location -> table mapping lives in `db.py` (`LOCATION_MAP`). Dashboard branch names are built per row
from the table and the Company column (e.g. `manjeri` + company ALIMS -> `ALIMS MANJERI`); `head_office`,
`manjeri_r_d`, `manjeri_fr`, `fco_manjeri` keep their plain names.

## API
Same routes as before. `GET /api/sync` and `POST /api/refresh` re-read Neon; `POST /api/developer/archive`
runs the cleanup; `POST /api/developer/fetch-data` streams the ESSL fetch log.