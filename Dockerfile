# syntax=docker/dockerfile:1

# ────────────────────────────────────────────
#  Stage 1 — frontend (Vite + TypeScript)
# ────────────────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ────────────────────────────────────────────
#  Stage 2 — backend (TypeScript → JS)
# ────────────────────────────────────────────
FROM node:22-alpine AS backend
WORKDIR /build/backend
# better-sqlite3 is a native addon: node-gyp needs these if no prebuilt binary matches
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ────────────────────────────────────────────
#  Stage 3 — runtime
# ────────────────────────────────────────────
FROM node:22-alpine
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
