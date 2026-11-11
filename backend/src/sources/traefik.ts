// ─────────────────────────────────────────────
//  Source: Traefik JSON access log (HTTP requests)
// ─────────────────────────────────────────────
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { Tail } from 'tail';
import { isIP } from 'net';
import { config } from '../config.js';
import { isPrivateIP, normalizeIp } from '../ip.js';
import { redactPath } from '../filters.js';
import type { ParsedLine } from '../types.js';

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Drop the query string, mask token-like segments, cap the length. */
function cleanPath(path: string): string {
  return redactPath(path.split('?')[0] ?? '/').slice(0, 120) || '/';
}

/** "jellyfin@docker" → "jellyfin", "websecure-app@file" → "websecure-app" */
function cleanRouterName(name: string): string {
  return name.replace(/@[a-z0-9-]+$/i, '') || name;
}

/**
 * Read a request header from a Traefik log entry. Traefik writes kept headers
 * as flat keys ("request_X-Forwarded-For"); older setups used a nested object.
 */
function header(o: Record<string, unknown>, name: string): string {
  const flat = `request_${name}`.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === flat) return str(o[k]);
  const nested = (o['request_headers'] ?? o['RequestHeaders']) as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') {
    for (const k of Object.keys(nested)) if (k.toLowerCase() === name.toLowerCase()) return str(nested[k]);
  }
  return '';
}

/**
 * Pick the client IP. Proxy headers are only present when Traefik is configured
 * to keep them (accessLog.fields.headers); by default ClientHost is used.
 */
function clientIp(o: Record<string, unknown>): string {
  const candidates = [
    header(o, 'Cf-Connecting-Ip'),
    header(o, 'X-Forwarded-For').split(',')[0] ?? '',
    header(o, 'X-Real-Ip'),
    str(o['ClientHost'] ?? o['client_host']),
    str(o['ClientAddr'] ?? o['client_addr']).replace(/:\d+$/, ''),
  ].map(c => normalizeIp(c)).filter(c => isIP(c));

  return candidates.find(c => !isPrivateIP(c)) ?? candidates[0] ?? '';
}

export function parseLogLine(raw: string): ParsedLine | null {
  const line = raw.trim();
  if (!line.startsWith('{')) return null;

  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; }
  catch { return null; }

  const ip = clientIp(o);
  if (!ip) return null;

  const router = str(o['RouterName'] ?? o['router_name'] ?? o['ServiceName'] ?? o['RequestHost'] ?? o['entryPointName']);
  const status = parseInt(str(o['DownstreamStatus'] ?? o['downstream_status'] ?? o['status'] ?? 0), 10);

  return {
    ip,
    router: cleanRouterName(router) || 'unknown',
    status: Number.isFinite(status) ? status : 0,
    method: str(o['RequestMethod'] ?? o['request_method']) || 'GET',
    path:   cleanPath(str(o['RequestPath'] ?? o['request_path']) || '/'),
    proto:  'http',
    port:   0,
  };
}

/** Last few lines of a file, without spawning a shell. */
function lastLines(path: string, n: number): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-n);
  } finally {
    closeSync(fd);
  }
}

function tailFile(onLine: (p: ParsedLine) => void): void {
  try {
    lastLines(config.logPath, 3).forEach((l, i) =>
      console.log(`   [sample ${i + 1}]`, parseLogLine(l) ? '✅ parsed' : '❌ not a Traefik JSON log line'));
  } catch { /* empty or unreadable — not fatal */ }

  const tail = new Tail(config.logPath, {
    encoding:       'utf8',
    flushAtEOF:     true,
    useWatchFile:   true,
    fsWatchOptions: { interval: 500 },
    fromBeginning:  false,
    follow:         true, // keep going across log rotation
  });
  tail.on('line',  line => { const p = parseLogLine(line); if (p) onLine(p); });
  tail.on('error', err  => console.error('[traefik] tail error:', err));
  console.log(`📜 Tailing Traefik access log ${config.logPath}`);
}

/**
 * Start tailing the Traefik access log. If the file doesn't exist yet, keep
 * checking and start as soon as it appears. Returns whether it started now.
 */
export function startTraefik(onLine: (p: ParsedLine) => void, onLateStart: () => void): boolean {
  if (existsSync(config.logPath)) { tailFile(onLine); return true; }

  console.warn(`⚠️  Traefik access log not found at ${config.logPath} — HTTP requests won't be shown until it appears`);
  const timer = setInterval(() => {
    if (!existsSync(config.logPath)) return;
    clearInterval(timer);
    tailFile(onLine);
    onLateStart();
  }, 30_000);
  timer.unref();
  return false;
}
