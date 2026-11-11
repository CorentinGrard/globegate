// ─────────────────────────────────────────────
//  Filters — what never reaches storage or viewers
// ─────────────────────────────────────────────
import { lookup } from 'dns/promises';
import { normalizeIp } from './ip.js';

// ── Secret-looking path segments ──────────────
// Webhook IDs, tokens and keys in URLs work like passwords
// (e.g. Home Assistant's /api/webhook/<64 hex chars>). They're replaced before
// a path is stored or shown.
export const REDACTED = '•••';

/**
 * Random tokens mix letters and digits all over; slugs and words don't.
 * Flag long segments where letter/digit switches are frequent.
 */
export function looksLikeSecret(segment: string): boolean {
  if (segment.length < 16 || !/^[A-Za-z0-9._~%=+-]+$/.test(segment)) return false;
  let digits = 0;
  let switches = 0;
  for (let i = 0; i < segment.length; i++) {
    const isDigit = segment.charCodeAt(i) >= 48 && segment.charCodeAt(i) <= 57;
    if (isDigit) digits++;
    if (i > 0) {
      const prev = segment.charCodeAt(i - 1) >= 48 && segment.charCodeAt(i - 1) <= 57;
      if (prev !== isDigit) switches++;
    }
  }
  return digits >= 3 && switches / segment.length >= 0.15;
}

export function redactPath(path: string): string {
  if (!path.includes('/')) return path;
  return path.split('/').map(s => (looksLikeSecret(s) ? REDACTED : s)).join('/');
}

// ── Ignored paths (health checks…) ────────────
/** Matcher for path prefixes: "/health" hides /health, /healthz and /health/live. */
export function createPathMatcher(prefixes: string[]): (path: string) => boolean {
  const list = prefixes.map(p => (p.startsWith('/') ? p : `/${p}`));
  if (!list.length) return () => false;
  return path => list.some(p => path.startsWith(p));
}

// ── Ignored hostnames (your own public IP) ────
type Lookup = (host: string) => Promise<string[]>;

const dnsLookup: Lookup = async host =>
  (await lookup(host, { all: true })).map(a => a.address);

/**
 * Keeps the current IPs of some hostnames, refreshed periodically. Used to hide
 * your own traffic: point it at a DNS name that follows your public IP (your
 * domain or DDNS name) and requests that loop back through the router
 * (NAT loopback: health checks, apps on your Wi-Fi…) disappear.
 */
export class HostIpSet {
  private ips = new Set<string>();

  constructor(
    private readonly hosts: string[],
    private readonly resolve: Lookup = dnsLookup,
  ) {}

  has(ip: string): boolean {
    return this.ips.has(normalizeIp(ip));
  }

  /** Resolve every host; a host that fails keeps its previous addresses. */
  async refresh(): Promise<void> {
    if (!this.hosts.length) return;
    const next = new Set<string>();
    const failed: string[] = [];
    for (const host of this.hosts) {
      try {
        for (const ip of await this.resolve(host)) next.add(normalizeIp(ip));
      } catch {
        failed.push(host);
      }
    }
    if (failed.length) {
      console.warn(`⚠️  IGNORE_HOSTS: could not resolve ${failed.join(', ')} — keeping previous addresses`);
      for (const ip of this.ips) next.add(ip);
    }
    const changed = next.size !== this.ips.size || [...next].some(ip => !this.ips.has(ip));
    this.ips = next;
    if (changed) console.log(`🙈 Ignoring own traffic from ${[...next].join(', ') || 'nothing'} (${this.hosts.join(', ')})`);
  }

  start(everyMs = 5 * 60_000): void {
    if (!this.hosts.length) return;
    void this.refresh();
    setInterval(() => void this.refresh(), everyMs).unref();
  }
}
