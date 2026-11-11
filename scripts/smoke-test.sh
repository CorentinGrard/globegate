#!/usr/bin/env bash
# Smoke-test a built image: it starts, serves the UI and API, produces demo
# traffic, and shuts down promptly on `docker stop`.
#   usage: scripts/smoke-test.sh <image> [port]
set -euo pipefail

IMAGE="${1:?usage: $0 <image> [port]}"
PORT="${2:-3999}"
NAME="globegate-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "❌ $*"; docker logs "$NAME" 2>&1 | tail -30 || true; exit 1; }

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" -e DEMO=true "$IMAGE" >/dev/null

echo "⏳ waiting for /health"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
health=$(curl -fsS "http://127.0.0.1:${PORT}/health") || fail "/health not reachable"
echo "✅ /health → $health"

curl -fsS "http://127.0.0.1:${PORT}/" | grep -q "<title>GlobeGate" || fail "index.html not served"
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/ne_110m_land.geojson" || fail "land data not served"
echo "✅ frontend served"

echo "⏳ waiting for demo traffic"
for _ in $(seq 1 15); do
  rows=$( (curl -fsS "http://127.0.0.1:${PORT}/api/history?limit=5" || true) | { grep -o '"id"' || true; } | wc -l)
  [ "$rows" -gt 0 ] && break
  sleep 1
done
[ "${rows:-0}" -gt 0 ] || fail "no connections recorded"
curl -fsS "http://127.0.0.1:${PORT}/api/history?limit=1" | grep -q '\.x"' || fail "IPs are not masked by default"
echo "✅ $rows connection(s) recorded, IPs masked"

start=$(date +%s)
docker stop -t 10 "$NAME" >/dev/null
took=$(( $(date +%s) - start ))
[ "$took" -le 5 ] || fail "container took ${took}s to stop (signals not handled)"
echo "✅ stopped in ${took}s"

echo "🎉 smoke test passed"
