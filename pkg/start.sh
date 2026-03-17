#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

if [ ! -d "frontend/node_modules" ]; then
  (cd frontend && npm install)
fi

(cd frontend && npm run build)

if [[ -f ".env" ]]; then
  set -a
  source .env
  set +a
fi

APP_PORT="${APP_PORT:-8502}"
exec uvicorn backend.main:app --host 0.0.0.0 --port "${APP_PORT}"
