# Changelog

All notable changes to GlobeGate are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Add your changes under **Unreleased** in the same PR as the code. `scripts/release.sh` turns that section into the next version.

## [Unreleased]

First public release.

### Added
- **Every inbound TCP/UDP connection**, not just HTTP: SSH, VPNs, game servers… read from the Linux connection-tracking table (`conntrack`). Works behind NAT and double NAT with port forwarding. Configure with `CONNTRACK*` variables.
- Protocol filter (All / HTTP / TCP / UDP), top countries panel and country flags in the feed.
- Privacy controls: `IP_DISPLAY` (`masked` by default, `full` or `hidden`) and `IGNORE_IPS` to drop addresses or ranges before they are stored.
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
- The GeoIP database is picked up as soon as it's downloaded and reloaded after weekly updates, without a restart.
- `docker stop` now shuts the container down immediately.

### Fixed
- The automatic GeoIP download never worked in the container (`curl` was missing from the image).
- Real traffic was shown at random cities when the GeoIP database was missing; it is now skipped until the database is available.
- Traefik logs with kept headers (`request_X-Forwarded-For`, `request_Cf-Connecting-Ip`) are now read correctly.
- Log fields are escaped before being displayed.
- Local `docker build` copied host `node_modules` into the image.
