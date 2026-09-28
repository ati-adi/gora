#!/usr/bin/env bash
# Development only: runs Gora behind a free localhost.run SSH tunnel so Telegram can open the Mini App.
# - reconnects the tunnel whenever it drops
# - pings the public URL every 60 s so the free tunnel is not closed for inactivity
# - when the public URL changes, writes it to .env (PUBLIC_URL) and restarts Gora so the menu
#   button and web_app buttons point at the new address
# Usage: scripts/dev-tunnel.sh          (Ctrl+C stops the tunnel and Gora)
# Logs: $LOG_DIR/gora.log (default ./data/logs), tunnel events on stdout.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8080}
LOG_DIR=${LOG_DIR:-./data/logs}
mkdir -p "$LOG_DIR"

GORA_PID=""
PING_PID=""
CURRENT_URL=""

start_gora() {
  node --env-file-if-exists=.env src/main.ts >>"$LOG_DIR/gora.log" 2>&1 &
  GORA_PID=$!
  echo "[dev-tunnel] gora started (pid $GORA_PID)"
}
stop_gora() {
  if [ -n "$GORA_PID" ]; then
    kill -TERM "$GORA_PID" 2>/dev/null
    wait "$GORA_PID" 2>/dev/null
    GORA_PID=""
  fi
}
start_pinger() {
  stop_pinger
  (while true; do sleep 60; curl -s -o /dev/null --max-time 10 "$1/healthz"; done) &
  PING_PID=$!
}
stop_pinger() {
  if [ -n "$PING_PID" ]; then kill "$PING_PID" 2>/dev/null; PING_PID=""; fi
}
set_public_url() {
  if grep -q '^PUBLIC_URL=' .env 2>/dev/null; then
    sed -i '' "s|^PUBLIC_URL=.*|PUBLIC_URL=$1|" .env
  else
    echo "PUBLIC_URL=$1" >>.env
  fi
}
cleanup() { stop_pinger; stop_gora; exit 0; }
trap cleanup INT TERM

while true; do
  while IFS= read -r line; do
    url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9]+\.lhr\.life' | head -1)
    if [ -n "$url" ] && [ "$url" != "$CURRENT_URL" ]; then
      CURRENT_URL=$url
      echo "[dev-tunnel] public URL: $CURRENT_URL"
      set_public_url "$CURRENT_URL"
      stop_gora
      start_gora
      start_pinger "$CURRENT_URL"
    fi
  done < <(ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -R "80:localhost:$PORT" nokey@localhost.run 2>&1)
  echo "[dev-tunnel] tunnel closed; reconnecting in 3 s"
  sleep 3
done
