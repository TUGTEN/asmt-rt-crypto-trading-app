# api/Dockerfile — the Go API in one small static image.
#
# Two stages: build with the Go toolchain, run the static binary on alpine.
# Alpine rather than scratch only because HEALTHCHECK below needs wget; the
# toolchain and the source never reach the runtime image.

FROM golang:1.25-alpine AS build
WORKDIR /src

# Dependencies first: editing a .go file then does not re-download modules.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO off and -trimpath: one static binary with no libc to match at runtime.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api .

FROM alpine:3.22

# The API's whole configuration surface, at the documented defaults
# (api/.env.example, README "Configuration"): `docker run` with no -e works,
# and docker-compose.yml overrides what it likes. PORT is read by the app and
# by the healthcheck.
ENV PORT=8080 \
    SEED=42 \
    SYMBOL=BTC-USD

RUN adduser -D -u 1001 app
COPY --from=build /api /usr/local/bin/api
USER app
EXPOSE 8080

# /api/config is the cheapest route that proves the process is serving: the
# trade loop and the routes are up. `$${PORT}` is escaped so the *shell*
# expands it at container start rather than the Dockerfile at build time.
HEALTHCHECK --interval=5s --timeout=2s --start-period=3s --retries=5 \
    CMD wget -q -O /dev/null "http://127.0.0.1:$${PORT}/api/config" || exit 1

ENTRYPOINT ["/usr/local/bin/api"]
