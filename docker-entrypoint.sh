#!/bin/sh
# Start the GeoIP updater in the background, then hand PID over to Node
# so `docker stop` reaches it directly (tini forwards the signal).
set -e

/app/geoip-update.sh &

exec node /app/backend/dist/server.js "$@"
