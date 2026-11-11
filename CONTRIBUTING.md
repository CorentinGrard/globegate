# Contributing to GlobeGate

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

- **Bugs and ideas**: open an [issue](https://github.com/CorentinGrard/globegate/issues/new/choose).
- **Larger changes**: open an issue first so we can agree on the approach before you spend time on it.
- **Security issues**: please don't open a public issue; see [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project layout

```
backend/            Node.js server (TypeScript)
  src/server.ts       HTTP + WebSocket wiring, startup and shutdown
  src/hub.ts          every source feeds this: filters → GeoIP → SQLite → WebSocket
  src/sources/        traefik.ts (access log), conntrack.ts (TCP/UDP), demo.ts
  src/ip.ts           IP parsing, private ranges, masking, CIDR matching
  src/types.ts        types shared with the frontend
  test/               unit tests (node:test)
frontend/           Vite + Three.js UI (TypeScript)
  src/globe.ts        scene, globe, camera controls
  src/arcs.ts         arcs, ripples, client-side filters
  src/types.ts        copy of backend/src/types.ts (CI checks they match)
  public/             static files: favicons, Natural Earth land shapes
scripts/            release.sh, smoke-test.sh
```

## Development setup

Requirements: Node.js 26 (a `mise.toml` is provided) and npm.

```bash
# Terminal 1: backend on :3000 with fake traffic
cd backend
npm ci
DEMO=true npm run dev

# Terminal 2: UI on http://localhost:5173 (proxies /api and /ws to :3000)
cd frontend
npm ci
npm run dev
```

To work with real data, point the backend at a Traefik log and a GeoLite2 database:

```bash
TRAEFIK_LOG_PATH=/path/to/access.log GEOIP_DB_PATH=/path/to/GeoLite2-City.mmdb npm run dev
```

Local data (SQLite database, defaults) lives in `backend/data/`, which is git-ignored.

To test the full image:

```bash
docker build -t globegate:dev .
scripts/smoke-test.sh globegate:dev
```

## Checks

CI runs these on every pull request; run them before pushing:

```bash
cd backend  && npm run typecheck && npm test && npm run build
cd frontend && npm run typecheck && npm run build
```

If you change `backend/src/types.ts`, copy it to `frontend/src/types.ts`.

## Pull requests

- Keep each PR focused on one change, and include tests for parsing or filtering logic.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything users would notice (`Added`, `Changed`, `Fixed`, `Removed`, `Security`).
- Update the README if you add or change a configuration variable.
- For UI changes, include a screenshot in the PR description.

## Code style

- TypeScript in strict mode; no unused variables.
- Prefer small modules with plain functions. Comments explain *why*, not *what*.
- Anything that comes from a log line or the network is untrusted: escape it before putting it in HTML (`esc()` in `frontend/src/util.ts`).
