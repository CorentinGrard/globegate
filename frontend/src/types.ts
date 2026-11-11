// ─────────────────────────────────────────────
//  Shared domain types
// ─────────────────────────────────────────────

export interface LatLon {
  lat: number;
  lon: number;
}

export interface GeoResult extends LatLon {
  city:        string;
  country:     string;
  countryCode: string;
}

/** Network owner, from GeoLite2-ASN (0 / '' when unknown) */
export interface AsnResult {
  asn: number;
  org: string;
}

/** How a connection reached the server */
export type Proto = 'http' | 'tcp' | 'udp';

/** Where connection events come from */
export type SourceName = 'traefik' | 'conntrack' | 'crowdsec' | 'demo';

/** Raw fields extracted from any event source (Traefik log line, conntrack event…) */
export interface ParsedLine {
  ip:     string;
  router: string;   // Traefik router name, or service name derived from the port
  status: number;   // HTTP status (0 for raw TCP/UDP)
  method: string;   // HTTP method (empty for raw TCP/UDP)
  path:   string;   // HTTP path   (empty for raw TCP/UDP)
  proto:  Proto;
  port:   number;   // destination port (0 when unknown)
}

/** A fully resolved connection, ready to broadcast / persist */
export interface Connection {
  id:          string;
  ip:          string;  // may be masked ("203.0.113.x") or empty, depending on IP_DISPLAY
  router:      string;
  status:      number;
  method:      string;
  path:        string;
  proto:       Proto;
  port:        number;
  color:       string;
  source:      LatLon;
  target:      LatLon;
  city:        string;
  country:     string;
  countryCode: string;
  asn:         number;  // autonomous system number, 0 when unknown
  org:         string;  // network owner (ISP, hosting company…), '' when unknown
  blocked:     boolean; // the IP was under an active CrowdSec ban at the time
  timestamp:   string; // ISO-8601
}

/** A CrowdSec decision (ban, captcha…) against an IP or a range */
export interface Ban {
  id:          string;
  ip:          string;  // IP or CIDR range, shown per IP_DISPLAY
  range:       boolean; // true when the decision covers a whole range
  scenario:    string;  // e.g. "crowdsecurity/ssh-bf"
  origin:      string;  // crowdsec (detected here), cscli / console (manual)
  type:        string;  // ban, captcha…
  source:      LatLon | null;  // null when GeoIP can't place it
  city:        string;
  country:     string;
  countryCode: string;
  asn:         number;
  org:         string;
  start:       string;  // ISO-8601, when GlobeGate first saw the decision
  until:       string;  // ISO-8601, when it expires (or was lifted)
}

/** GET /api/visitor — everything stored about the IP behind a connection or a ban */
export interface VisitorResponse {
  ip:          string;  // per IP_DISPLAY
  source:      LatLon;
  city:        string;
  country:     string;
  countryCode: string;
  asn:         number;
  org:         string;
  total:       number;
  firstSeen:   number;  // epoch ms (0 when only a ban is known)
  lastSeen:    number;
  byRouter:    Record<string, number>;
  byStatus:    Record<string, number>;
  byPort:      { proto: Proto; port: number; n: number }[];
  activity:    { from: number; to: number; buckets: number[] };
  recent:      Connection[];  // newest first
  bans:        Ban[];         // newest first
}

/** What the frontend receives on WebSocket init */
export interface InitPayload {
  serverLocation:    LatLon & { label: string };
  recentConnections: Connection[];
  serviceColors:     Record<string, string>;
  oldest:            number; // epoch ms
  sources:           SourceName[];
  version:           string;
  ipDisplay:         'full' | 'masked' | 'hidden';
  bans:              Ban[];   // active CrowdSec decisions (empty when not connected)
}

/** One of the most active IPs of a period */
export interface TopVisitor {
  conn:        string;  // id of its latest connection in the period (opens its details)
  ip:          string;  // per IP_DISPLAY
  city:        string;
  country:     string;
  countryCode: string;
  org:         string;
  n:           number;
}

/** GET /api/summary — totals for a period: what the side panels show */
export interface SummaryResponse {
  from:        number;
  to:          number;
  total:       number;
  byRouter:    Record<string, number>;
  byCountry:   { country: string; cc: string; n: number }[];
  byProto:     Record<string, number>;
  topVisitors: TopVisitor[];
  oldest:      number;  // first stored connection (epoch ms)
}

/** GET /api/history — connections to play back: an even sample of a window */
export interface HistoryResponse {
  rows:  Connection[];   // oldest first
  total: number;         // connections in the window (rows may be a sample)
  bans:  Ban[];          // CrowdSec decisions active at some point in the window
  next:  number | null;  // time of the first connection after the window
}

export type WsMessage =
  | { type: 'init';       data: InitPayload }
  | { type: 'connection'; data: Connection }
  | { type: 'ban';        data: Ban }
  | { type: 'unban';      data: { id: string } };
