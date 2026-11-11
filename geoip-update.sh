#!/bin/sh
# ─────────────────────────────────────────────
#  GeoLite2-City auto-updater
#  Runs at container start, then weekly. The app reloads the file automatically.
#
#  MAXMIND_LICENSE_KEY  required
#  MAXMIND_ACCOUNT_ID   recommended (uses MaxMind's current authenticated endpoint;
#                       without it the legacy license_key URL is used)
# ─────────────────────────────────────────────
set -u

DB_PATH="${GEOIP_DB_PATH:-/geoip/GeoLite2-City.mmdb}"
GEOIP_DIR=$(dirname "$DB_PATH")
MAX_AGE_DAYS=7

log() { echo "[geoip-update] $*"; }

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  if [ ! -f "$DB_PATH" ]; then
    log "No MAXMIND_LICENSE_KEY set and no database at $DB_PATH — connections can't be geolocated."
    log "Get a free key at https://www.maxmind.com/en/geolite2/signup or mount GeoLite2-City.mmdb."
  fi
  exit 0
fi

update() {
  log "Downloading GeoLite2-City…"
  TMP=$(mktemp -d)
  if [ -n "${MAXMIND_ACCOUNT_ID:-}" ]; then
    curl -fsSL -u "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
      "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz" \
      -o "$TMP/db.tar.gz"
  else
    curl -fsSL \
      "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
      -o "$TMP/db.tar.gz"
  fi || { log "Download failed (check MAXMIND_LICENSE_KEY / MAXMIND_ACCOUNT_ID)"; rm -rf "$TMP"; return 1; }

  tar -xzf "$TMP/db.tar.gz" -C "$TMP" || { log "Extract failed"; rm -rf "$TMP"; return 1; }
  MMDB=$(find "$TMP" -name '*.mmdb' | head -n 1)
  if [ -z "$MMDB" ]; then log "No .mmdb file in archive"; rm -rf "$TMP"; return 1; fi

  mkdir -p "$GEOIP_DIR"
  # Copy next to the target, then rename: the app never sees a half-written file
  cp "$MMDB" "$DB_PATH.tmp" && mv -f "$DB_PATH.tmp" "$DB_PATH"
  rm -rf "$TMP"
  log "✅ Updated $DB_PATH"
}

if [ ! -f "$DB_PATH" ]; then
  update
elif [ -n "$(find "$DB_PATH" -mtime +$MAX_AGE_DAYS 2>/dev/null)" ]; then
  log "Database older than $MAX_AGE_DAYS days"
  update
else
  log "Database is fresh"
fi

while true; do
  sleep 604800 # 7 days
  update
done
