#!/bin/sh
# run-local.sh — both halves locally with no Docker (see ADR-0002).
#
#   ./scripts/run-local.sh            # builds api + web, serves :8080 + :3000
#   curl -sSL https://raw.githubusercontent.com/TUGTEN/pitchfork/main/scripts/run-local.sh | sh
#
# Builds the Go binary (`go build ./...` in api/) and the Next standalone
# server (`BUILD_STANDALONE=1 npm run build` in web/), then runs both with one
# Ctrl-C cleaning up both. Ports stay :8080/:3000 to match docker-compose,
# the README, and the Backend presets. Env overrides: PORT, SEED, SYMBOL,
# WEB_PORT, NEXT_PUBLIC_API_URL.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
API_PORT="${PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:${API_PORT}}"
API_BIN="${API_BIN:-$ROOT/.tmp-local/api}"
API_PID=""
WEB_PID=""

cleanup() {
  if [ -n "${WEB_PID}" ]; then kill "${WEB_PID}" 2>/dev/null || true; fi
  if [ -n "${API_PID}" ]; then kill "${API_PID}" 2>/dev/null || true; fi
}
trap cleanup INT TERM EXIT

command -v go >/dev/null 2>&1 || { echo "run-local: go toolchain not found" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "run-local: node not found" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "run-local: npm not found" >&2; exit 1; }

echo "run-local: building api..."
mkdir -p "$(dirname "$API_BIN")"
(cd "$ROOT/api" && CGO_ENABLED=0 go build -trimpath -o "$API_BIN" .)

echo "run-local: building web (standalone)..."
if [ ! -d "$ROOT/web/node_modules" ]; then
  (cd "$ROOT/web" && npm ci)
fi
(cd "$ROOT/web" && BUILD_STANDALONE=1 NEXT_PUBLIC_API_URL="$API_URL" NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null)

echo "run-local: starting api on :${API_PORT}..."
PORT="$API_PORT" "$API_BIN" &
API_PID="$!"

echo "run-local: starting web on :${WEB_PORT}..."
(cd "$ROOT/web" && PORT="$WEB_PORT" HOSTNAME="127.0.0.1" node .next/standalone/server.js) &
WEB_PID="$!"

echo ""
echo "  api    http://localhost:$API_PORT  (config: /api/config)"
echo "  screen http://localhost:$WEB_PORT  (debug: ?debug=1 or press \` )"
echo "  tunnel cloudflared tunnel --url http://localhost:$API_PORT  (paste via Backend panel)"
echo ""
echo "Ctrl-C stops both."
wait
