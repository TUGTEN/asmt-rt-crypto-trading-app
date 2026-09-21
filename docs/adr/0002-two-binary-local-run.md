# Local run: two binaries on 8080+3000, no Docker required

`scripts/run-local.sh` builds the Go API and the Next standalone server and runs both on `:8080`/`:3000` with trap cleanup, curled from `raw.githubusercontent.com/.../main/scripts/run-local.sh`; we kept the two-port CORS shape instead of embedding the UI in Go so the local path matches compose, the Vercel split, and every documented curl.
