// ─────────────────────────────────────────────
//  What viewers are allowed to see
// ─────────────────────────────────────────────
//  Everything sent to the browser goes through these: IPs per IP_DISPLAY, and
//  token-like path segments masked (also covers rows stored by older versions).
import { config } from './config.js';
import { maskIp } from './ip.js';
import { redactPath } from './filters.js';
import type { BanRow } from './db.js';
import type { Ban, Connection } from './types.js';

export function displayIp(ip: string): string {
  return config.ipDisplay === 'full' ? ip : config.ipDisplay === 'masked' ? maskIp(ip) : '';
}

/** A CIDR range as shown to viewers: wide ranges as they are, narrow ones masked. */
function displayRange(range: string): string {
  if (config.ipDisplay === 'full') return range;
  if (config.ipDisplay === 'hidden') return '';
  const [net = '', bits = ''] = range.split('/');
  const wide = net.includes(':') ? Number(bits) <= 48 : Number(bits) <= 24;
  return wide ? range : maskIp(net);
}

export function toPublic(c: Connection): Connection {
  const path = redactPath(c.path);
  const ip = displayIp(c.ip);
  return ip === c.ip && path === c.path ? c : { ...c, ip, path };
}

export function toPublicBan(b: BanRow): Ban {
  return {
    id:          String(b.id),
    ip:          b.scope === 'range' ? displayRange(b.value) : displayIp(b.value),
    range:       b.scope === 'range',
    scenario:    b.scenario,
    origin:      b.origin,
    type:        b.type,
    source:      b.src_lat === null || b.src_lon === null ? null : { lat: b.src_lat, lon: b.src_lon },
    city:        b.city,
    country:     b.country,
    countryCode: b.cc,
    asn:         b.asn,
    org:         b.org,
    start:       new Date(b.start).toISOString(),
    until:       new Date(b.until).toISOString(),
  };
}
