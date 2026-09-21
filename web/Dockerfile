# web/Dockerfile — the Next.js trading screen as a self-hosted Node server.
#
# Three stages: install, build, run. The runtime stage carries the standalone
# output (the traced subset of node_modules the server needs), not the
# toolchain, not the source, not the full dependency tree.
#
# This file is for `docker compose up`. Vercel builds the same source with its
# own pipeline and needs nothing from here (README "Deployment").

FROM node:24-alpine AS deps
WORKDIR /app
# Lockfile-exact install: the image must not drift from the verified tree.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* is inlined into the browser bundle at build time, so the API
# URL is a build argument, not a runtime variable: changing it means building
# again (locally, this is the host's published API port — the browser calls the
# API directly and cannot resolve a compose service name).
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Ask for .next/standalone from this build only (next.config.ts explains why
# the switch is here rather than always on).
ENV BUILD_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001
# standalone ships its own server.js plus the traced node_modules; the static
# assets are served from .next/static beside it. (This app has no public/ dir;
# add a COPY for it if one appears.)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# The page is a statically prerendered shell, so a 200 here means the UI is
# being served (whether the *market* is reachable is the screen's own job to
# report — it shows stale rather than lying).
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
    CMD wget -q -O /dev/null "http://127.0.0.1:$${PORT}/" || exit 1

CMD ["node", "server.js"]
