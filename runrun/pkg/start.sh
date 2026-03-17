#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/shaobin/Desktop/code/gangliandata/pkg"
PORT="8502"
PID_FILE="$PROJECT_DIR/.uvicorn_8502.pid"
LOG_DIR="$PROJECT_DIR/.run_logs"
LOG_FILE="$LOG_DIR/uvicorn_8502.log"

mkdir -p "$LOG_DIR"

is_target_cmd() {
  local cmd="$1"
  [[ "$cmd" == *"$PROJECT_DIR"* && "$cmd" == *"uvicorn"* && "$cmd" == *"backend.main:app"* ]]
}

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    old_cmd="$(ps -p "$old_pid" -o command= 2>/dev/null || true)"
    if is_target_cmd "$old_cmd"; then
      echo "服务已在运行 (PID: $old_pid, URL: http://localhost:$PORT)"
      exit 0
    fi
  fi
  rm -f "$PID_FILE"
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，启动已取消（避免影响其它服务）。"
  echo "占用进程："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  exit 1
fi

cd "$PROJECT_DIR"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt >/dev/null

if [[ ! -d "frontend/node_modules" ]]; then
  (cd frontend && npm install >/dev/null)
fi

(cd frontend && npm run build >/dev/null)

if [[ -f ".env" ]]; then
  set -a
  source .env
  set +a
fi

nohup uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" >>"$LOG_FILE" 2>&1 &

run_pid=""
for _ in {1..60}; do
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if is_target_cmd "$cmd"; then
      run_pid="$pid"
      break 2
    fi
  done
  sleep 0.5
done

if [[ -n "$run_pid" ]]; then
  echo "$run_pid" > "$PID_FILE"
  echo "启动成功: http://localhost:$PORT"
  echo "PID: $run_pid"
  echo "日志: $LOG_FILE"
else
  echo "启动失败，端口 $PORT 未监听。请检查日志: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
