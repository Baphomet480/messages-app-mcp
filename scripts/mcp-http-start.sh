#!/usr/bin/env bash
# Thin wrapper for backward compatibility. Prefer scripts/mcp-stack.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/mcp-stack.sh" start --no-mcpo "$@"
