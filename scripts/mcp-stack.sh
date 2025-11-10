#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/messages-app-mcp"
HTTP_PID_FILE="${LOG_DIR}/mcp-http.pid"

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="3338"
# Default allowlist mirrors package.json start:http (127.0.0.1, localhost, ::1)
DEFAULT_ALLOWED_HOSTS="127.0.0.1,localhost,::1"

HOST="${MESSAGES_MCP_HOST:-${DEFAULT_HOST}}"
PORT="${MESSAGES_MCP_PORT:-${DEFAULT_PORT}}"
ALLOWED_HOSTS="${MESSAGES_MCP_ALLOWED_HOSTS:-${DEFAULT_ALLOWED_HOSTS}}"
ENABLE_SSE="${MESSAGES_MCP_ENABLE_SSE:-1}"

PATH="${PATH:-}"

prepend_path() {
  local dir="$1"
  if [[ -d "${dir}" ]] && [[ ":${PATH}:" != *":${dir}:"* ]]; then
    PATH="${dir}:${PATH}"
  fi
}

# LaunchAgents and GUI wrappers inherit a minimal PATH, so explicitly seed the
# common locations for Homebrew/bin plus pnpm shims to ensure node/pnpm resolve.
prepend_path "/opt/homebrew/bin"
prepend_path "/opt/homebrew/sbin"
prepend_path "/usr/local/bin"
prepend_path "/usr/local/sbin"
prepend_path "/usr/bin"
prepend_path "/bin"
prepend_path "/usr/sbin"
prepend_path "/sbin"
if [[ -n "${PNPM_HOME:-}" ]]; then
  prepend_path "${PNPM_HOME}"
fi
prepend_path "${HOME}/Library/pnpm"
prepend_path "${HOME}/.local/share/pnpm"
export PATH

require_bin() {
  local bin="$1"
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "Error: '${bin}' is not on PATH (${PATH})." >&2
    echo "Set PNPM_HOME or adjust PATH for GUI/launchd contexts and retry." >&2
    exit 1
  fi
}

ensure_log_dir() {
  mkdir -p "${LOG_DIR}"
}

usage() {
  cat <<'HELP'
Usage: mcp-stack.sh <command>

Commands:
  start      Start the Messages MCP HTTP server.
  stop       Stop the Messages MCP HTTP server.
  restart    Restart the Messages MCP HTTP server.
  status     Show PID/state information.
  watch      Run the MCP server in watch mode (foreground ts-node).
  help       Show this message.

Environment overrides:
  MESSAGES_MCP_HOST, MESSAGES_MCP_PORT, MESSAGES_MCP_ALLOWED_HOSTS
  MESSAGES_MCP_ENABLE_SSE=0/1
HELP
}

read_pid() {
  local file="$1"
  [[ -f "${file}" ]] && cat "${file}"
}

is_running() {
  local pid_file="$1"
  local pid
  pid=$(read_pid "${pid_file}" || true)
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

start_http() {
  require_bin "node"
  if is_running "${HTTP_PID_FILE}"; then
    echo "messages-app-mcp HTTP server already running (pid $(read_pid "${HTTP_PID_FILE}"))"
    return
  fi

  ensure_log_dir

  local log_file="${LOG_DIR}/mcp-http.out"
  local err_file="${LOG_DIR}/mcp-http.err"

  cd "${ROOT_DIR}"
  local cmd=(node dist/index.js --http --host "${HOST}" --port "${PORT}")
  if [[ "${ENABLE_SSE}" != "0" ]]; then
    cmd+=(--enable-sse)
  fi

  echo "Starting messages-app-mcp on ${HOST}:${PORT}"
  nohup env \
    MESSAGES_MCP_HTTP_ALLOWED_HOSTS="${ALLOWED_HOSTS}" \
    "${cmd[@]}" >>"${log_file}" 2>>"${err_file}" &

  local pid=$!
  echo "${pid}" >"${HTTP_PID_FILE}"
  echo "messages-app-mcp started (pid ${pid})"
}

stop_http() {
  if ! is_running "${HTTP_PID_FILE}"; then
    rm -f "${HTTP_PID_FILE}"
    echo "messages-app-mcp HTTP server not running"
    return
  fi

  local pid
  pid=$(read_pid "${HTTP_PID_FILE}")
  echo "Stopping messages-app-mcp (pid ${pid})"
  kill "${pid}"
  wait "${pid}" 2>/dev/null || true
  rm -f "${HTTP_PID_FILE}"
  echo "messages-app-mcp stopped"
}

status() {
  if is_running "${HTTP_PID_FILE}"; then
    echo "messages-app-mcp: running (pid $(read_pid "${HTTP_PID_FILE}"))"
  else
    echo "messages-app-mcp: stopped"
  fi
}

watch_mode() {
  cd "${ROOT_DIR}"
  echo "Running messages-app-mcp in watch mode on ${HOST}:${PORT}"
  require_bin "pnpm"
  local cmd=(pnpm exec ts-node --esm --watch src/index.ts --http --host "${HOST}" --port "${PORT}")
  if [[ "${ENABLE_SSE}" != "0" ]]; then
    cmd+=(--enable-sse)
  fi
  env \
    MESSAGES_MCP_HTTP_ALLOWED_HOSTS="${ALLOWED_HOSTS}" \
    "${cmd[@]}"
}

command="${1:-help}"
shift || true

case "${command}" in
  start)
    start_http
    ;;
  stop)
    stop_http
    ;;
  restart)
    stop_http
    start_http
    ;;
  status)
    status
    ;;
  watch)
    watch_mode
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: ${command}" >&2
    usage
    exit 1
    ;;
esac
