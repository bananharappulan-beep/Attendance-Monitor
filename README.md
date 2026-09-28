# Attendance Monitor (Flask + Google Sheets)

Python Flask backend + plain HTML / CSS / JavaScript front end. No database.

* **Source sheet** (`SHEET_ID`) - raw punch data, one tab per branch (read only).
* **Output sheet** (`OUTPUT_SHEET_ID`) - the saved status matrix, **one worksheet per branch**:

```
EMP NAME | 27-09-2026 | 28-09-2026 | 29-09-2026 | 30-09-2026
BANA     | A          | P          |            |
```

P = worked 7h or more, H = 4h to under 7h, A = less than 4h or no record.
A blank cell means there are no attendance records for that date yet.
Each sync updates the dates found in the source and keeps the dates already saved.

## Structure
```
app.py            Flask app, API routes, background sync scheduler
config.py         Settings read from .env
sheets_sync.py    Read source sheet, calculate P/H/A, save matrix to the output sheet
templates/index.html
static/css/style.css
static/js/app.js
```

## Setup
1. **Service account**: Google Cloud Console -> create a project -> enable *Google Sheets API* ->
   create a service account -> Keys -> Add key -> JSON. Save the file next to `app.py`.
2. **Source sheet**: share it with the service account's email (`client_email` inside the JSON) as *Viewer*.
3. **Output sheet**: create a NEW empty Google Sheet, share it with the same email as *Editor*,
   and copy its ID from the URL (`https://docs.google.com/spreadsheets/d/<THIS-PART>/edit`).
4. Install and configure:
   ```
   python -m venv venv
   venv\Scripts\activate           # macOS/Linux: source venv/bin/activate
   pip install -r requirements.txt
   copy .env.example .env          # macOS/Linux: cp .env.example .env
   ```
   Edit `.env`: set `GOOGLE_CREDENTIALS` and `OUTPUT_SHEET_ID`.
5. Run:
   ```
   python app.py
   ```
   Open http://localhost:8080 . The first sync runs ~5 seconds after start, then every
   `SYNC_INTERVAL_MINUTES`. Use the **Sync Sheet** button to run it immediately.

Production: `gunicorn -w 1 -b 0.0.0.0:8080 app:app`
(use a single worker so the background sync runs only once).

## API
| Route | Description |
|---|---|
| `GET /api/branches` | List of branches |
| `GET /api/data?branch=NAME` | Attendance rows for a branch |
| `GET /api/sync` | Re-read the source and save the matrix to the output sheet |

The source tabs need these header columns (tab name = branch):
`Date`, `Employee Code`, `Employee Name`, `In Time`, `Out Time`.
