// ─────────────────────────────────────────────
//  Visitor details — everything stored about one IP
// ─────────────────────────────────────────────
import { geolocate, lookupAsn } from './geo.js';
import { createIpMatcher, isPrivateIP } from './ip.js';
import { getBan, ipOfConnection, queryBansForIp, queryVisitor, type BanRow } from './db.js';
import { displayIp, toPublic, toPublicBan } from './public.js';
import type { VisitorResponse } from './types.js';

/** Look up by connection id or by ban id. Null when neither exists. */
export function visitorDetails(by: { conn?: number; ban?: number }): VisitorResponse | null {
  let ip: string | null = null;
  let ban: BanRow | null = null;
  if (by.conn !== undefined) ip = ipOfConnection(by.conn);
  else if (by.ban !== undefined) {
    ban = getBan(by.ban);
    if (ban?.scope === 'ip') ip = ban.value;
  }
  if (!ip && !ban) return null;

  // A range ban isn't one visitor: show the decision only
  if (!ip) {
    const b = toPublicBan(ban!);
    return {
      ip: b.ip, source: b.source ?? { lat: 0, lon: 0 }, city: b.city, country: b.country,
      countryCode: b.countryCode, asn: b.asn, org: b.org, total: 0, firstSeen: 0, lastSeen: 0,
      byRouter: {}, byStatus: {}, byPort: [], activity: { from: 0, to: 0, buckets: [] }, recent: [], bans: [b],
    };
  }

  const v = queryVisitor(ip);
  const { exact, ranges } = queryBansForIp(ip);
  const bans = [...exact, ...ranges.filter(r => createIpMatcher([r.value])(ip))]
    .sort((a, b) => b.start - a.start).slice(0, 20);

  // Location: latest connection, else the ban, else a fresh lookup
  const last = v.recent[0];
  const geo = last
    ? { lat: last.source.lat, lon: last.source.lon, city: last.city, country: last.country, countryCode: last.countryCode }
    : ban?.src_lat != null && ban.src_lon != null
      ? { lat: ban.src_lat, lon: ban.src_lon, city: ban.city, country: ban.country, countryCode: ban.cc }
      : isPrivateIP(ip) ? null : geolocate(ip);
  // Rows stored before the ASN database was added have no ISP
  const net = last?.asn ? { asn: last.asn, org: last.org } : lookupAsn(ip);

  return {
    ip:          displayIp(ip),
    source:      geo ? { lat: geo.lat, lon: geo.lon } : { lat: 0, lon: 0 },
    city:        geo?.city ?? '',
    country:     geo?.country ?? '',
    countryCode: geo?.countryCode ?? '',
    asn:         net.asn,
    org:         net.org,
    total:       v.total,
    firstSeen:   v.firstSeen,
    lastSeen:    v.lastSeen,
    byRouter:    v.byRouter,
    byStatus:    v.byStatus,
    byPort:      v.byPort,
    activity:    v.activity,
    recent:      v.recent.map(toPublic),
    bans:        bans.map(toPublicBan),
  };
}
