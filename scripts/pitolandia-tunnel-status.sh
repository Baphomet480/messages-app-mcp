#!/usr/bin/env bash
set -euo pipefail

# Pitolandia reverse SSH tunnel status helper
# - Checks LaunchAgent, autossh process, remote listener, and MCP HTTP manifest
# - Suitable for menu scripts; supports one-line or JSON output

HOST_ALIAS="ssh.pitolandia.com"
REMOTE_PORT="3338"
LOCAL_URL="http://127.0.0.1:${REMOTE_PORT}/mcp/manifest"
LOCAL_FORWARD_PORT="5150"
LOCAL_FORWARD_TARGET="127.0.0.1:5150"

mode="human"  # human|oneline|json
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) mode="json" ; shift ;;
    --one-line|--oneline|-q) mode="oneline" ; shift ;;
    *) echo "Usage: pitolandia-tunnel-status.sh [--json|--one-line]" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || perl -MJSON::PP -0777 -ne 'print JSON::PP->new->encode($_)' 2>/dev/null; }

status_ok=true
notes=()

# LaunchAgent status (macOS host)
la_pid=""
la_loaded=false
if launchctl list | grep -q "com.pitolandia.tunnel"; then
  la_loaded=true
  la_pid=$(launchctl list | awk '/com\.pitolandia\.tunnel/ {print $1}') || true
  [[ "$la_pid" =~ ^[0-9]+$ ]] || la_pid=""
else
  notes+=("LaunchAgent not loaded")
  status_ok=false
fi

# autossh process (or fallback ssh)
autossh_pids=""
ssh_pids=""
if have pgrep; then
  autossh_pids=$(pgrep -af "autossh -M 0 -N.*${HOST_ALIAS}" | awk '{print $1}' | paste -sd, -) || true
  ssh_pids=$(pgrep -af "ssh -N .*${HOST_ALIAS}" | awk '{print $1}' | paste -sd, -) || true
fi
[[ -n "$autossh_pids" || -n "$ssh_pids" ]] || notes+=("tunnel ssh process not running")

# Local listener and manifest
local_listen=false
if have lsof; then
  if lsof -nP -iTCP:"${REMOTE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then local_listen=true; fi
elif have ss; then
  if ss -lnt | grep -q "127.0.0.1:${REMOTE_PORT}"; then local_listen=true; fi
fi

local_forward=false
if have lsof; then
  if lsof -nP -iTCP:"${LOCAL_FORWARD_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then local_forward=true; fi
elif have ss; then
  if ss -lnt | grep -q "127.0.0.1:${LOCAL_FORWARD_PORT}"; then local_forward=true; fi
fi
[[ $local_forward == true ]] || notes+=("local forward 127.0.0.1:${LOCAL_FORWARD_PORT} missing")

local_manifest=""
if have curl; then
  local_manifest=$(curl -fsS --max-time 2 "$LOCAL_URL" 2>/dev/null || true)
fi
[[ -n "$local_manifest" ]] || notes+=("local manifest unreachable")

# Remote listener and manifest
remote_output=$(ssh -o BatchMode=yes -o ConnectTimeout=4 -o ControlMaster=no "$HOST_ALIAS" 'command -v ss >/dev/null && ss -lnt || (command -v netstat >/dev/null && netstat -lnt) || true' 2>/dev/null || true)
remote_listen=false
remote_service=false
if [[ -n "$remote_output" && "$remote_output" == *"127.0.0.1:${REMOTE_PORT}"* ]]; then
  remote_listen=true
else
  notes+=("remote 127.0.0.1:${REMOTE_PORT} not listening")
  status_ok=false
fi
if [[ -n "$remote_output" && "$remote_output" == *":${LOCAL_FORWARD_PORT}"* ]]; then
  remote_service=true
else
  notes+=("remote service ${LOCAL_FORWARD_TARGET} not listening")
fi

remote_manifest=""
remote_manifest=$(ssh -o BatchMode=yes -o ConnectTimeout=4 -o ControlMaster=no "$HOST_ALIAS" 'if command -v curl >/dev/null; then curl -fsS --max-time 2 http://127.0.0.1:'"${REMOTE_PORT}"'/mcp/manifest; elif command -v wget >/dev/null; then wget -qO- --timeout=2 http://127.0.0.1:'"${REMOTE_PORT}"'/mcp/manifest; fi' 2>/dev/null || true)
[[ -n "$remote_manifest" ]] || notes+=("remote manifest unreachable")

# Overall result
summary="OK"
if [[ $remote_listen != true ]]; then
  summary="DOWN"
elif [[ $local_forward != true || $remote_service != true || -z $local_manifest || -z $remote_manifest ]]; then
  summary="DEGRADED"
fi

case "$mode" in
  human)
    echo "Tunnel: $summary"
    echo "- LaunchAgent: $([[ $la_loaded == true ]] && echo "loaded${la_pid:+ pid=$la_pid}" || echo "not loaded")"
    echo "- autossh: ${autossh_pids:-absent}"
    [[ -n "$ssh_pids" ]] && echo "- ssh fallback pids: $ssh_pids"
    echo "- Local listener: $([[ $local_listen == true ]] && echo yes || echo no) 127.0.0.1:${REMOTE_PORT}"
    echo "- Remote reverse: $([[ $remote_listen == true ]] && echo yes || echo no) 127.0.0.1:${REMOTE_PORT}"
    echo "- Local forward: $([[ $local_forward == true ]] && echo yes || echo no) 127.0.0.1:${LOCAL_FORWARD_PORT}"
    echo "- Remote service: $([[ $remote_service == true ]] && echo yes || echo no) ${LOCAL_FORWARD_TARGET}"
    echo "- Local manifest: $([[ -n $local_manifest ]] && echo ok || echo fail)"
    echo "- Remote manifest: $([[ -n $remote_manifest ]] && echo ok || echo fail)"
    if ((${#notes[@]})); then
      echo "Notes: ${notes[*]}"
    fi
    ;;
  oneline)
    if ((${#notes[@]})); then
      echo "$summary: ${notes[*]}"
    else
      echo "$summary"
    fi
    ;;
  json)
    # Build a minimal JSON payload without external deps
    printf '{"summary":%s,"launchagent":{"loaded":%s,"pid":%s},"autossh_pids":%s,"ssh_pids":%s,"local_listener":%s,"local_forward":%s,"remote_reverse":%s,"remote_service":%s,"local_manifest":%s,"remote_manifest":%s,"notes":%s}\n' \
      "$(printf %s "$summary" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$( $la_loaded && echo true || echo false)" \
      "$( [[ -n $la_pid ]] && echo "$la_pid" || echo null )" \
      "$( printf '[%s]' "${autossh_pids//,/","}" )" \
      "$( printf '[%s]' "${ssh_pids//,/","}" )" \
      "$( $local_listen && echo true || echo false)" \
      "$( $local_forward && echo true || echo false)" \
      "$( $remote_listen && echo true || echo false)" \
      "$( $remote_service && echo true || echo false)" \
      "$( [[ -n $local_manifest ]] && echo true || echo false)" \
      "$( [[ -n $remote_manifest ]] && echo true || echo false)" \
      "$( printf '[%s]' "$(for n in "${notes[@]:-}"; do printf '"%s",' "$n"; done | sed 's/,$//')" )"
    ;;
esac

if [[ "$summary" == "OK" ]]; then exit 0; fi
if [[ "$summary" == "DEGRADED" ]]; then exit 1; fi
exit 2
