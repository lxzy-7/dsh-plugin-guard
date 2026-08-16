#!/usr/bin/env bash
# boot-guard.sh — guarded boot for DeepSeek Harness (macOS/Linux).
#
# Snapshots every profile, starts `dsh web`, health-checks it, and on failure
# kills the server, rolls back to the last good snapshot and retries once.
# On first-attempt failure it also writes an incident report + pending marker.
#
# Wire it into your launcher (or run it directly):
#   DSH_HOME="$HOME/.dsh" HARNSESS_ROOT=/path/to/harness ./boot-guard.sh
#
# Requires: node (for the guard CLI), curl (health probe).
set -u

FIRST_WAIT_SEC="${FIRST_WAIT_SEC:-60}"
RETRY_WAIT_SEC="${RETRY_WAIT_SEC:-30}"
PORT="${PORT:-3080}"
PROFILE="${PROFILE:-web}"
HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_HOME

CLI="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-plugin-guard/scripts/guard-cli.js"
[ -f "$CLI" ] || CLI="$HARNESS_ROOT/node_modules/dsh-plugin-guard/scripts/guard-cli.js"

LOG_DIR="$DSH_HOME/guard/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BOOT_LOG="$LOG_DIR/boot-$STAMP.log"
SERVER_OUT="$LOG_DIR/server-$STAMP.out.log"
SERVER_ERR="$LOG_DIR/server-$STAMP.err.log"
STATUS_FILE="$LOG_DIR/last-boot.txt"

log() { echo "[$(date +%H:%M:%S)] $*" >> "$BOOT_LOG"; }
set_status() { echo "$(date '+%F %T') $1 $2 (log: $STAMP)" > "$STATUS_FILE"; }
healthy() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; }
guard() { node "$CLI" "$@" 2>&1 | while IFS= read -r line; do [ -n "$line" ] && log "  [guard] $line"; done; }

wait_healthy() {
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    healthy && return 0
    sleep 0.5
  done
  return 1
}

start_server() {
  local dsh_cmd="$HARNESS_ROOT/node_modules/.bin/dsh"
  [ -x "$dsh_cmd" ] || dsh_cmd="dsh"
  ( setsid "$dsh_cmd" web >"$SERVER_OUT" 2>"$SERVER_ERR" < /dev/null & )
  echo $!
}

stop_server() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
}

log "=== boot guard start ==="
if healthy; then
  log "already healthy"
  set_status OK already-running
  exit 0
fi

guard snapshot --tag pre-boot --reason "automatic snapshot before boot"

PID=$(start_server)
log "started server (pgid $PID)"
if wait_healthy "$FIRST_WAIT_SEC"; then
  log "boot ok on first attempt"
  set_status OK first-attempt
  # Stay attached so launchers that kill the process group on window close
  # keep their close-to-quit semantics.
  wait
  log "server exited; boot guard done"
  exit 0
fi
log "server unhealthy after ${FIRST_WAIT_SEC}s; stopping and rolling back"
stop_server "$PID"

guard rollback --good

PID2=$(start_server)
log "restarted server (pgid $PID2)"
if wait_healthy "$RETRY_WAIT_SEC"; then
  set_status OK rolled-back-retry
else
  stop_server "$PID2"
  set_status FAILED boot-failed
fi

guard incident --kind boot-failure

if healthy; then
  wait
  log "server exited; boot guard done"
  exit 0
fi
exit 1
