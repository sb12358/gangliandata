#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/shaobin/Desktop/code/pkg"
PORT="8502"
PID_FILE="$PROJECT_DIR/.streamlit_8502.pid"

is_target_cmd() {
  local cmd="$1"
  [[ "$cmd" == *"$PROJECT_DIR"* && "$cmd" == *"streamlit"* && "$cmd" == *"app.py"* ]]
}

stop_pid() {
  local pid="$1"
  if [[ -z "${pid:-}" ]]; then
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if ! is_target_cmd "$cmd"; then
    return 1
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  ! kill -0 "$pid" 2>/dev/null
}

stopped="0"

if [[ -f "$PID_FILE" ]]; then
  pid_from_file="$(cat "$PID_FILE" 2>/dev/null || true)"
  if stop_pid "$pid_from_file"; then
    echo "已停止服务 (PID: $pid_from_file, URL: http://localhost:$PORT)"
    stopped="1"
  fi
  rm -f "$PID_FILE"
fi

# 兜底：只处理监听 8502 且命令匹配本项目的进程
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  if stop_pid "$pid"; then
    echo "已停止服务 (PID: $pid, URL: http://localhost:$PORT)"
    stopped="1"
  else
    echo "发现端口 $PORT 进程 PID=$pid，但不是本项目服务，已跳过。"
  fi
done

if [[ "$stopped" == "0" ]]; then
  echo "未发现本项目运行中的服务（http://localhost:$PORT）。"
else
  echo "停止完成。"
fi
