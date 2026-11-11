// ─────────────────────────────────────────────
//  Source: CrowdSec bans (Local API decision stream)
// ─────────────────────────────────────────────
//
//  GlobeGate registers like a bouncer (read-only API key) and polls
//  /v1/decisions/stream: the first call returns every active decision, later
//  calls only what was added or removed since the previous one.
//
//  Setup: cscli bouncers add globegate   → CROWDSEC_API_KEY
//         CROWDSEC_LAPI_URL=http://<crowdsec host>:8080
import { isIP } from 'net';
import { config } from '../config.js';
import { geolocate, lookupAsn } from '../geo.js';
import { isPrivateIP, normalizeIp } from '../ip.js';
import type { BanRow } from '../db.js';
import type { GeoResult } from '../types.js';

/** One decision as returned by the Local API */
export interface Decision {
  id:         number;
  origin:     string;
  type:       string;
  scope:      string;
  value:      string;
  duration:   string;   // remaining time, Go syntax: "3h59m58.1s"
  until?:     string;   // ISO date (CrowdSec ≥ 1.5)
  scenario:   string;
  simulated?: boolean;
}

export interface StreamResponse {
  new:     Decision[] | null;
  deleted: Decision[] | null;
}

export interface CrowdSecHandlers {
  /** Full list of active decisions (first pull, or after an outage). */
  sync:   (rows: BanRow[]) => void;
  added:  (row: BanRow) => void;
  lifted: (id: number) => void;
  online: (up: boolean) => void;
}

const UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1e3, m: 6e4, h: 3.6e6 };

/** Go duration string → milliseconds ("1h2m3.5s" → 3723500). NaN when invalid. */
export function parseGoDuration(d: string): number {
  const m = /^(-?)((?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+)$/.exec(d.trim());
  if (!m) return NaN;
  let ms = 0;
  for (const [, n, unit] of m[2]!.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) ms += Number(n) * UNITS[unit!]!;
  return m[1] ? -ms : ms;
}

/** Turn a decision into a stored ban. Returns null for scopes we can't draw (usernames, countries…). */
export function decisionToBan(d: Decision, now = Date.now(), geo?: GeoResult | null): BanRow | null {
  const scope = d.scope?.toLowerCase();
  if (scope !== 'ip' && scope !== 'range') return null;
  if (d.simulated) return null; // not enforced

  const value = scope === 'ip' ? normalizeIp(d.value) : d.value.trim().toLowerCase();
  const addr  = scope === 'ip' ? value : normalizeIp(value.split('/')[0] ?? '');
  if (!isIP(addr)) return null;

  const untilParsed = d.until ? Date.parse(d.until) : NaN;
  const remaining   = parseGoDuration(d.duration ?? '');
  const until = Number.isFinite(untilParsed) ? untilParsed
    : Number.isFinite(remaining) ? now + remaining : now + 4 * 3_600_000;

  const loc = geo !== undefined ? geo : isPrivateIP(addr) ? null : geolocate(addr);
  const asn = lookupAsn(addr);
  return {
    id:       d.id,
    value,
    scope,
    scenario: d.scenario ?? '',
    origin:   d.origin ?? '',
    type:     d.type || 'ban',
    start:    now,
    until,
    src_lat:  loc?.lat ?? null,
    src_lon:  loc?.lon ?? null,
    city:     loc?.city ?? '',
    country:  loc?.country ?? '',
    cc:       loc?.countryCode ?? '',
    asn:      asn.asn,
    org:      asn.org,
  };
}

/** One call to /v1/decisions/stream. Throws with a readable message on failure. */
export async function pullDecisions(startup: boolean, fetchImpl: typeof fetch = fetch): Promise<StreamResponse> {
  const q = new URLSearchParams({ startup: String(startup), scopes: 'ip,range' });
  if (config.crowdsecOrigins.length) q.set('origins', config.crowdsecOrigins.join(','));
  let res: Response;
  try {
    res = await fetchImpl(`${config.crowdsecUrl}/v1/decisions/stream?${q}`, {
      headers: { 'X-Api-Key': config.crowdsecKey ?? '', 'User-Agent': `GlobeGate/${config.version}` },
      signal:  AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    throw new Error(`can't reach ${config.crowdsecUrl} (${e.cause?.code ?? e.name ?? e.message})`);
  }
  if (res.status === 403 || res.status === 401) throw new Error('API key rejected (create one with: cscli bouncers add globegate)');
  if (!res.ok) throw new Error(`HTTP ${res.status} from the Local API`);
  const body = await res.json() as StreamResponse;
  return { new: body?.new ?? [], deleted: body?.deleted ?? [] };
}

// ── Polling loop ──────────────────────────────
let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function stopCrowdSec(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}

/** Wanted origins only (the server filters too, but older versions ignore `origins`). */
function wanted(d: Decision): boolean {
  return !config.crowdsecOrigins.length || config.crowdsecOrigins.some(o => o.toLowerCase() === d.origin?.toLowerCase());
}

/**
 * Start polling CrowdSec. Returns false when it isn't configured.
 * Failures are logged once, retried with backoff, and followed by a full
 * resync so nothing is missed.
 */
export function startCrowdSec(h: CrowdSecHandlers, fetchImpl: typeof fetch = fetch): boolean {
  if (!config.crowdsecUrl) return false;
  if (!config.crowdsecKey) {
    console.error('❌ CROWDSEC_LAPI_URL is set but CROWDSEC_API_KEY is empty — create a key with: cscli bouncers add globegate');
    return false;
  }

  let synced = false;
  let failures = 0;
  let lastError = '';

  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();
      const r = await pullDecisions(!synced, fetchImpl);
      const rows = (r.new ?? []).filter(wanted).map(d => decisionToBan(d, now)).filter((b): b is BanRow => b !== null);
      if (!synced) {
        h.sync(rows);
        console.log(`🛡  CrowdSec connected — ${rows.length} active ban${rows.length === 1 ? '' : 's'} (${config.crowdsecOrigins.join(', ') || 'all origins'})`);
      } else {
        for (const d of r.deleted ?? []) h.lifted(d.id);
        for (const b of rows) h.added(b);
      }
      if (!synced) h.online(true); // first pull, or back after an outage
      synced = true;
      failures = 0;
      lastError = '';
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== lastError) console.warn(`⚠️  CrowdSec: ${msg} — retrying`);
      lastError = msg;
      if (!failures) h.online(false);
      failures++;
      synced = false; // pull the full list again once it's back
    }
    if (stopped) return;
    const delay = failures ? Math.min(60_000, config.crowdsecPollMs * 2 ** Math.min(failures, 4)) : config.crowdsecPollMs;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };

  void tick();
  return true;
}
