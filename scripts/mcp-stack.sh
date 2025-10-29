#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/messages-app-mcp"
HTTP_PID_FILE="${LOG_DIR}/mcp-http.pid"
MCPO_PID_FILE="${LOG_DIR}/mcpo.pid"

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="3338"
# Default allowlist mirrors package.json start:http (127.0.0.1, localhost, ::1)
DEFAULT_ALLOWED_HOSTS="127.0.0.1,localhost,::1"

HOST="${MESSAGES_MCP_HOST:-${DEFAULT_HOST}}"
PORT="${MESSAGES_MCP_PORT:-${DEFAULT_PORT}}"
ALLOWED_HOSTS="${MESSAGES_MCP_ALLOWED_HOSTS:-${DEFAULT_ALLOWED_HOSTS}}"
ENABLE_SSE="${MESSAGES_MCP_ENABLE_SSE:-1}"
MCPO_ENABLED="${MESSAGES_MCP_ENABLE_MCPO:-1}"
MCPO_PORT="${MCPO_PORT:-9000}"
MCPO_API_KEY="${MCPO_API_KEY:-development-key}"
MCPO_SERVER_TYPE="${MCPO_SERVER_TYPE:-streamable-http}"
MCPO_BIN="${MCPO_BIN:-mcpo}"
MCPO_TARGET_URL="${MCPO_TARGET_URL:-http://${HOST}:${PORT}/mcp}"
MCPO_LOG_FILE="${LOG_DIR}/mcpo.out"
MCPO_ERR_FILE="${LOG_DIR}/mcpo.err"

ensure_log_dir() {
  mkdir -p "${LOG_DIR}"
}

usage() {
  cat <<'EOF'
Usage: mcp-stack.sh <command> [options]

Commands:
  start [--no-mcpo]      Start the Messages MCP HTTP server (and mcpo proxy unless disabled).
  stop [--no-mcpo]       Stop the stack (optionally skip mcpo).
  restart                Restart both services.
  status                 Show PID/state information.
  watch [--no-mcpo]      Run the MCP server in watch mode (foreground ts-node). mcpo stays optional.
  help                   Show this message.

Environment overrides:
  MESSAGES_MCP_HOST, MESSAGES_MCP_PORT, MESSAGES_MCP_ALLOWED_HOSTS
  MESSAGES_MCP_ENABLE_SSE=0/1, MESSAGES_MCP_ENABLE_MCPO=0/1
  MCPO_PORT, MCPO_API_KEY, MCPO_SERVER_TYPE, MCPO_BIN, MCPO_TARGET_URL
  MCPO_EXTRA_ARGS (space separated flags appended to mcpo command)
EOF
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

start_mcpo() {
  local skip="$1"
  if [[ "${skip}" == "1" ]]; then
    return
  fi
  if [[ "${MCPO_ENABLED}" == "0" ]]; then
    echo "mcpo disabled via MESSAGES_MCP_ENABLE_MCPO"
    return
  fi

  if is_running "${MCPO_PID_FILE}"; then
    echo "mcpo already running (pid $(read_pid "${MCPO_PID_FILE}"))"
    return
  fi

  if ! command -v "${MCPO_BIN}" >/dev/null 2>&1; then
    if command -v uvx >/dev/null 2>&1; then
      MCPO_BIN="uvx"
    else
      echo "mcpo command not found. Install mcpo or set MCPO_BIN." >&2
      return 1
    fi
  fi

  ensure_log_dir

  echo -n "Waiting for MCP server at ${MCPO_TARGET_URL} "
  local max_attempts=30
  local attempt=0
  until curl --silent --fail --max-time 2 "${MCPO_TARGET_URL}/manifest" >/dev/null; do
    printf '.'
    attempt=$((attempt + 1))
    if (( attempt >= max_attempts )); then
      echo "\nTimed out waiting for MCP server. mcpo not started." >&2
      return 1
    fi
    sleep 1
  done
  echo " ok"

  local mcpo_cmd
  if [[ "${MCPO_BIN}" == "uvx" ]]; then
    mcpo_cmd=(uvx mcpo)
  else
    mcpo_cmd=("${MCPO_BIN}")
  fi

  local extra_args=()
  if [[ -n "${MCPO_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra_args=(${MCPO_EXTRA_ARGS})
  fi

  local full_cmd=("${mcpo_cmd[@]}" --port "${MCPO_PORT}" --api-key "${MCPO_API_KEY}" --server-type "${MCPO_SERVER_TYPE}" "${extra_args[@]}" -- "${MCPO_TARGET_URL}")

  echo "Starting mcpo proxy on port ${MCPO_PORT}"
  nohup "${full_cmd[@]}" >>"${MCPO_LOG_FILE}" 2>>"${MCPO_ERR_FILE}" &

  local pid=$!
  echo "${pid}" >"${MCPO_PID_FILE}"
  echo "mcpo started (pid ${pid})"
}

stop_mcpo() {
  local skip="$1"
  if [[ "${skip}" == "1" ]]; then
    return
  fi
  if ! is_running "${MCPO_PID_FILE}"; then
    rm -f "${MCPO_PID_FILE}"
    echo "mcpo proxy not running"
    return
  fi

  local pid
  pid=$(read_pid "${MCPO_PID_FILE}")
  echo "Stopping mcpo (pid ${pid})"
  kill "${pid}"
  wait "${pid}" 2>/dev/null || true
  rm -f "${MCPO_PID_FILE}"
  echo "mcpo stopped"
}

status() {
  if is_running "${HTTP_PID_FILE}"; then
    echo "messages-app-mcp: running (pid $(read_pid "${HTTP_PID_FILE}"))"
  else
    echo "messages-app-mcp: stopped"
  fi

  if is_running "${MCPO_PID_FILE}"; then
    echo "mcpo: running (pid $(read_pid "${MCPO_PID_FILE}"))"
  else
    echo "mcpo: stopped"
  fi
}

watch_mode() {
  local skip_mcpo="$1"
  cd "${ROOT_DIR}"
  echo "Running messages-app-mcp in watch mode on ${HOST}:${PORT}"
  local cmd=(pnpm exec ts-node --esm --watch src/index.ts --http --host "${HOST}" --port "${PORT}")
  if [[ "${ENABLE_SSE}" != "0" ]]; then
    cmd+=(--enable-sse)
  fi
  env \
    MESSAGES_MCP_HTTP_ALLOWED_HOSTS="${ALLOWED_HOSTS}" \
    "${cmd[@]}"
  # watch mode runs in foreground; mcpo should be managed manually if needed
  if [[ "${skip_mcpo}" != "1" ]]; then
    echo "Watch mode keeps the MCP server in the foreground. Run mcpo in another terminal if needed."
  fi
}

parse_skip_flag() {
  local skip=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-mcpo)
        skip=1
        shift
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done
  echo "${skip}"
}

command="${1:-help}"
shift || true

case "${command}" in
  start)
    skip=$(parse_skip_flag "$@")
    start_http
    start_mcpo "${skip}"
    ;;
  stop)
    skip=$(parse_skip_flag "$@")
    stop_mcpo "${skip}"
    stop_http
    ;;
  restart)
    stop_mcpo "0"
    stop_http
    start_http
    start_mcpo "0"
    ;;
  status)
    status
    ;;
  watch)
    skip=$(parse_skip_flag "$@")
    watch_mode "${skip}"
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
