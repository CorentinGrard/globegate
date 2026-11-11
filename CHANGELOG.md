# Changelog

All notable changes to GlobeGate are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Add your changes under **Unreleased** in the same PR as the code. `scripts/release.sh` turns that section into the next version.

## [Unreleased]

## [1.0.0] - 2026-11-11

First public release.

### Added
- **Replay player**: pick a period (last hour, 6 hours, 24 hours or 7 days) and watch it like a video. Click the timeline to jump to a moment, ▶ plays the whole period in about a minute (speed adjustable), quiet stretches are skipped, pausing freezes the arcs, and playback rejoins live when it catches up. The side panels sum up the chosen period, live or replaying.
- **Visitor details**: click an arc, a feed card or a visitor to see everything stored about that IP: network owner, first and last visit, activity over the week, services, ports and status codes, latest requests and CrowdSec bans.
- **ISP names** from MaxMind GeoLite2-ASN, downloaded with the same key (`GEOIP_ASN_DB_PATH` to use your own file).
- **CrowdSec bans**: with `CROWDSEC_LAPI_URL` and a bouncer key (`CROWDSEC_API_KEY`), banned attackers appear as red dots, new bans strike the server and show in the feed, requests from banned IPs are marked 🛡, and a panel lists the active bans. Only bans decided on your server or by you are shown by default (`CROWDSEC_ORIGINS`).
- *Top* panel with services, countries and the most active visitors.
- Demo mode now also shows returning visitors, ISPs and bans.
- **Every inbound TCP/UDP connection**, not just HTTP: SSH, VPNs, game servers… read from the Linux connection-tracking table (`conntrack`). Works behind NAT and double NAT with port forwarding. Configure with `CONNTRACK*` variables.
- Protocol filter (All / HTTP / TCP / UDP), top countries panel and country flags in the feed.
- Privacy controls: `IP_DISPLAY` (`masked` by default, `full` or `hidden`) and `IGNORE_IPS` to drop addresses or ranges before they are stored.
- `IGNORE_HOSTS` hides your own traffic coming back through the router (NAT loopback), following your public IP through DNS; `IGNORE_PATHS` hides health-check endpoints.
- Token-like path segments (webhook IDs, invite links, UUIDs) are masked before being stored or shown.
- `RETENTION_DAYS` to choose how long history is kept (default 7).
- `MAXMIND_ACCOUNT_ID` to use MaxMind's current authenticated download endpoint.
- `DEMO` to force or disable demo mode.
- `LISTEN_ADDRESS` to listen on a single address, e.g. the Docker bridge IP when running with host networking behind Traefik.
- Version shown in the settings drawer and returned by `/health`.
- Multi-arch images (amd64, arm64) with SBOM and build provenance, published to GHCR on every release.

### Changed
- Redesigned interface: dotted globe with atmosphere glow, animated arcs with impact ripples, glass panels, floating timeline, responsive layout.
- Fonts are bundled with the app; the page no longer loads anything from third-party servers.
- Traefik router names are shown without their provider suffix (`jellyfin@docker` → `jellyfin`).
- The WebSocket endpoint moved to `/ws`.
- Runs on Node.js 26 (LTS), with Express 5, three.js r187, Vite 8 and TypeScript 7. The image no longer needs build tools.
- The GeoIP database is picked up as soon as it's downloaded and reloaded after weekly updates, without a restart.
- `docker stop` now shuts the container down immediately.

### Fixed
- History: picking a new period while a replay was running mixed both replays together.
- History: clicking **Live** while already live cleared the feed and counters, and returning to live lost the live totals and the services list.
- History: the timeline tooltip didn't follow the cursor while dragging.
- History: the density bars loaded every stored timestamp on each refresh; they're now counted by the database.
- The automatic GeoIP download never worked in the container (`curl` was missing from the image).
- Real traffic was shown at random cities when the GeoIP database was missing; it is now skipped until the database is available.
- Traefik logs with kept headers (`request_X-Forwarded-For`, `request_Cf-Connecting-Ip`) are now read correctly.
- Log fields are escaped before being displayed, and feed cards are built without `innerHTML`.
- `/api/density` validates the bucket count itself (CodeQL `js/resource-exhaustion`).
- Local `docker build` copied host `node_modules` into the image.

[Unreleased]: https://github.com/CorentinGrard/globegate/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CorentinGrard/globegate/releases/tag/v1.0.0
