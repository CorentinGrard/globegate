// ─────────────────────────────────────────────
//  Runtime configuration from environment
// ─────────────────────────────────────────────
//  Defaults suit local development (`npm run dev`). The Docker image sets the
//  container paths (/logs, /geoip, /data) through ENV in the Dockerfile.
import { readFileSync } from 'fs';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function float(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid env var ${name}: "${v}"`);
  return n;
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Invalid env var ${name}: "${v}"`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = env(name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Invalid env var ${name}: "${v}" (expected one of ${allowed.join(', ')})`);
  }
  return v as T;
}

export function parseList(v: string | undefined): string[] {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/** "22:ssh,25565:minecraft" → { 22: 'ssh', 25565: 'minecraft' } */
export function parsePortNames(v: string | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  for (const pair of parseList(v)) {
    const [port, name] = pair.split(':');
    const n = Number(port);
    if (Number.isInteger(n) && name?.trim()) out[n] = name.trim();
  }
  return out;
}

function readVersion(): string {
  if (env('APP_VERSION')) return env('APP_VERSION')!;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

export const config = {
  version:     readVersion(),
  port:        int('PORT', 3000),
  // Address to listen on (default: all interfaces). With network_mode: host, set
  // it to the Docker bridge IP (e.g. 172.17.0.1) so only containers such as
  // your reverse proxy can reach the UI — not the whole LAN.
  listenAddress: env('LISTEN_ADDRESS'),

  // ── Paths ──
  logPath:     env('TRAEFIK_LOG_PATH') ?? './data/access.log',
  geoipDb:     env('GEOIP_DB_PATH')    ?? './data/GeoLite2-City.mmdb',
  dbPath:      env('DB_PATH')          ?? './data/connections.db',

  // ── Server marker ──
  serverLat:   float('SERVER_LAT', 48.8566),
  serverLon:   float('SERVER_LON', 2.3522),
  serverLabel: env('SERVER_LABEL') ?? 'My Server',

  // ── History ──
  retentionMs: int('RETENTION_DAYS', 7) * 24 * 3_600_000,

  // ── Privacy ──
  // full   = show complete IPs to viewers
  // masked = hide the host part (203.0.113.x / 2001:db8:abcd::/48)  ← default
  // hidden = never send IPs to the browser
  ipDisplay:   oneOf('IP_DISPLAY', ['full', 'masked', 'hidden'] as const, 'masked'),
  // IPs / CIDR ranges that are dropped before anything is stored or shown
  ignoreIps:   parseList(env('IGNORE_IPS')),
  // Hostnames whose current IPs are dropped — e.g. your own domain, to hide
  // traffic that loops back through the router (health checks, apps on Wi-Fi)
  ignoreHosts: parseList(env('IGNORE_HOSTS')),
  // HTTP path prefixes that are dropped, e.g. health-check endpoints
  ignorePaths: parseList(env('IGNORE_PATHS')),

  // ── Raw TCP/UDP connections via Linux conntrack ──
  // auto = enable when conntrack works (needs host network + NET_ADMIN)
  conntrack:            oneOf('CONNTRACK', ['auto', 'true', 'false'] as const, 'auto'),
  // Ports already covered by the Traefik access log — skipped to avoid duplicates
  conntrackIgnorePorts: new Set(parseList(env('CONNTRACK_IGNORE_PORTS') ?? '80,443').map(Number)),
  // Only show these ports (empty = all)
  conntrackOnlyPorts:   new Set(parseList(env('CONNTRACK_ONLY_PORTS')).map(Number)),
  // Same IP + port is shown at most once per this many seconds
  conntrackDedupeMs:    int('CONNTRACK_DEDUPE_SECONDS', 30) * 1000,
  // Extra / overriding port → service names
  conntrackPortNames:   parsePortNames(env('CONNTRACK_PORT_NAMES')),

  // ── Demo ──
  // auto = generate fake traffic only when no real source is available
  demo: oneOf('DEMO', ['auto', 'true', 'false'] as const, 'auto'),
} as const;
