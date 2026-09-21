#!/bin/sh
# setup-local.sh — set this repo up on your machine, nothing more.
#
#   ./scripts/setup-local.sh         # tools, deps, quick verify, next steps
#   ./scripts/setup-local.sh --full  # plus the full gate suite (tests, lint, build)
#
# Pure sh. Fly/Vercel connects plus deploy-on-push are manual —
# see README "Deployment".
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

say() { printf '\n==> %s\n' "$1"; }
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "setup: missing: $1 ($2)" >&2; exit 1; }
}

say "tools"
need go "https://go.dev/dl/"
need node "https://nodejs.org/ (20+)"
need npm "(ships with node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then echo "setup: node 20+ required, have $(node -v)" >&2; exit 1; fi
echo "setup: go ($(go version)) + node ($(node -v)) OK"
if command -v docker >/dev/null 2>&1; then
  echo "setup: docker OK — compose path available"
else
  echo "setup: no docker — two-binary path only (fine)"
fi

say "web deps"
if [ ! -d "$ROOT/web/node_modules" ]; then
  (cd "$ROOT/web" && npm ci)
else
  echo "setup: web/node_modules present, skipping npm ci"
fi

say "verify"
(cd "$ROOT/api" && go vet ./... && echo "setup: api vets clean")
(cd "$ROOT/web" && npm run typecheck >/dev/null && echo "setup: web typechecks")

if [ "${1:-}" = "--full" ]; then
  say "full gates"
  (cd "$ROOT/api" && go test ./...)
  (cd "$ROOT/web" && npm test -- --run >/dev/null && npm run lint && npm run build >/dev/null)
  echo "setup: full gates green"
fi

say "run it"
echo "  ./scripts/run-local.sh     # :8080 api + :3000 screen, no Docker"
echo "  docker compose up --build  # same stack, in containers"
