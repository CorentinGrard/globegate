#!/bin/sh
# ─────────────────────────────────────────────
#  GeoLite2 auto-updater: GeoLite2-City (locations) + GeoLite2-ASN (ISP names)
#  Runs at container start, then weekly. The app reloads the files automatically.
#
#  MAXMIND_LICENSE_KEY  required
#  MAXMIND_ACCOUNT_ID   recommended (uses MaxMind's current authenticated endpoint;
#                       without it the legacy license_key URL is used)
# ─────────────────────────────────────────────
set -u

CITY_DB="${GEOIP_DB_PATH:-/geoip/GeoLite2-City.mmdb}"
GEOIP_DIR=$(dirname "$CITY_DB")
ASN_DB="${GEOIP_ASN_DB_PATH:-$GEOIP_DIR/GeoLite2-ASN.mmdb}"
MAX_AGE_DAYS=7

log() { echo "[geoip-update] $*"; }

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  if [ ! -f "$CITY_DB" ]; then
    log "No MAXMIND_LICENSE_KEY set and no database at $CITY_DB — connections can't be geolocated."
    log "Get a free key at https://www.maxmind.com/en/geolite2/signup or mount GeoLite2-City.mmdb."
  fi
  exit 0
fi

# download <edition> <target file>
download() {
  log "Downloading $1…"
  TMP=$(mktemp -d)
  if [ -n "${MAXMIND_ACCOUNT_ID:-}" ]; then
    curl -fsSL -u "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
      "https://download.maxmind.com/geoip/databases/$1/download?suffix=tar.gz" \
      -o "$TMP/db.tar.gz"
  else
    curl -fsSL \
      "https://download.maxmind.com/app/geoip_download?edition_id=$1&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
      -o "$TMP/db.tar.gz"
  fi || { log "$1 download failed (check MAXMIND_LICENSE_KEY / MAXMIND_ACCOUNT_ID)"; rm -rf "$TMP"; return 1; }

  tar -xzf "$TMP/db.tar.gz" -C "$TMP" || { log "Extract failed"; rm -rf "$TMP"; return 1; }
  MMDB=$(find "$TMP" -name '*.mmdb' | head -n 1)
  if [ -z "$MMDB" ]; then log "No .mmdb file in archive"; rm -rf "$TMP"; return 1; fi

  mkdir -p "$(dirname "$2")"
  # Copy next to the target, then rename: the app never sees a half-written file
  cp "$MMDB" "$2.tmp" && mv -f "$2.tmp" "$2"
  rm -rf "$TMP"
  log "✅ Updated $2"
}

# Missing or older than a week
stale() { [ ! -f "$1" ] || [ -n "$(find "$1" -mtime +$MAX_AGE_DAYS 2>/dev/null)" ]; }

update_all() {
  download GeoLite2-City "$CITY_DB"
  download GeoLite2-ASN "$ASN_DB" || log "ISP names will be missing until GeoLite2-ASN downloads"
}

if stale "$CITY_DB"; then download GeoLite2-City "$CITY_DB"; else log "GeoLite2-City is fresh"; fi
if stale "$ASN_DB"; then
  download GeoLite2-ASN "$ASN_DB" || log "ISP names will be missing until GeoLite2-ASN downloads"
else
  log "GeoLite2-ASN is fresh"
fi

while true; do
  sleep 604800 # 7 days
  update_all
done
