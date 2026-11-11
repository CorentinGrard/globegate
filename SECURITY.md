# Security policy

## Supported versions

Security fixes are released for the latest minor version. Please upgrade to the latest release (`ghcr.io/corentingrard/globegate:latest`) before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub: go to the [Security tab](https://github.com/CorentinGrard/globegate/security) and click **Report a vulnerability**. Include what you found, how to reproduce it, and the impact you expect.

You can expect an acknowledgement within a week. Once a fix is released, the advisory is published and you're credited unless you prefer otherwise.

## Deployment notes

GlobeGate displays information about people who connect to your server. Some things to keep in mind:

- The dashboard has **no built-in authentication**. If it's reachable from the internet, put it behind your reverse proxy's authentication.
- With `network_mode: host` and `NET_ADMIN` (needed for TCP/UDP tracking), the container can see the host's network activity. Only enable it if you want that feature.
- Visitor IPs are stored in the local SQLite database for `RETENTION_DAYS` and masked in the UI by default (`IP_DISPLAY=masked`).
- Treat your MaxMind license key as a secret: keep it in `.env`, never in `compose.yaml` or the repository.
