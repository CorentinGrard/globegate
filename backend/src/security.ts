// ─────────────────────────────────────────────
//  Browser-facing protections: CSP and WebSocket origin check
// ─────────────────────────────────────────────
import type { IncomingHttpHeaders } from 'http';

/**
 * The page only loads its own files: scripts, styles and fonts are bundled,
 * data comes from /api and /ws on the same host. Fonts may be inlined as data:
 * URIs by Vite. 'self' in connect-src also covers ws:// and wss:// to the same host.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

function first(h: string | string[] | undefined): string | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  return v?.split(',')[0]?.trim().toLowerCase() || undefined;
}

/**
 * Whether a WebSocket upgrade may proceed. Browsers send cookies (including a
 * reverse proxy's login session) with cross-site WebSocket connections, so any
 * page you visit could otherwise open /ws and read your traffic. Accept:
 * - no Origin header: not a browser, so it can't be riding your cookies;
 * - an Origin whose host matches the Host the request was sent to (or the
 *   X-Forwarded-Host set by the reverse proxy);
 * - an Origin listed in ALLOWED_ORIGINS, for proxies that rewrite the Host.
 */
export function isAllowedOrigin(headers: IncomingHttpHeaders, allowed: readonly string[] = []): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  if (allowed.some(a => a.replace(/\/+$/, '').toLowerCase() === o.origin)) return true;
  const host = o.host.toLowerCase();
  return host === first(headers.host) || host === first(headers['x-forwarded-host']);
}
