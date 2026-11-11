# syntax=docker/dockerfile:1

# ────────────────────────────────────────────
#  Stage 1 — frontend (Vite + TypeScript)
# ────────────────────────────────────────────
FROM node:26-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ────────────────────────────────────────────
#  Stage 2 — backend (TypeScript → JS)
# ────────────────────────────────────────────
FROM node:26-alpine AS backend
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
# --ignore-scripts: nothing here needs an install script. better-sqlite3 loads its
# bundled prebuilt binary (musl x64/arm64), so no compiler or node-gyp is needed.
RUN npm ci --ignore-scripts
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ────────────────────────────────────────────
#  Stage 3 — runtime
# ────────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app

# libstdc++      runtime dependency of the better-sqlite3 binary
# conntrack-tools see every inbound TCP/UDP connection (optional, see README)
# curl           GeoIP database downloads
# tini           PID 1: forwards signals and reaps child processes
RUN apk add --no-cache libstdc++ conntrack-tools curl tini

COPY --from=backend  /build/backend/node_modules ./backend/node_modules
COPY --from=backend  /build/backend/dist         ./backend/dist
COPY --from=backend  /build/backend/package.json ./backend/
COPY --from=frontend /build/frontend/dist        ./frontend/dist
COPY --chmod=755 geoip-update.sh docker-entrypoint.sh ./

ARG VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${VERSION} \
    PORT=3000 \
    TRAEFIK_LOG_PATH=/logs/access.log \
    GEOIP_DB_PATH=/geoip/GeoLite2-City.mmdb \
    DB_PATH=/data/connections.db

LABEL org.opencontainers.image.title="GlobeGate" \
      org.opencontainers.image.description="A live 3D globe of every connection to your server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

VOLUME ["/data", "/geoip"]
EXPOSE 3000

# Probe the address the app listens on (LISTEN_ADDRESS), or loopback when it listens everywhere
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD a="${LISTEN_ADDRESS:-127.0.0.1}"; \
      case "$a" in 0.0.0.0|::|"[::]") a=127.0.0.1 ;; *:*) a="[$a]" ;; esac; \
      wget -qO- "http://$a:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
