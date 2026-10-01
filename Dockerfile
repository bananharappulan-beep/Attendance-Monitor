FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HEADLESS=1
ENV PYTHONUNBUFFERED=1

CMD gunicorn app:app --workers 1 --threads 16 --timeout 120 --bind 0.0.0.0:${PORT:-10000}