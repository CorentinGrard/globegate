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

/** How a connection reached the server */
export type Proto = 'http' | 'tcp' | 'udp';

/** Where connection events come from */
export type SourceName = 'traefik' | 'conntrack' | 'demo';

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
  timestamp:   string; // ISO-8601
}

/** What the frontend receives on WebSocket init */
export interface InitPayload {
  serverLocation:    LatLon & { label: string };
  recentConnections: Connection[];
  stats:             Record<string, number>;
  serviceColors:     Record<string, string>;
  oldest:            number; // epoch ms
  sources:           SourceName[];
  version:           string;
  ipDisplay:         'full' | 'masked' | 'hidden';
}

/** GET /api/history — a replay window: evenly sampled rows + exact totals */
export interface HistoryResponse {
  rows:      Connection[];
  total:     number;
  byRouter:  Record<string, number>;
  byCountry: { country: string; cc: string; n: number }[];
  byProto:   Record<string, number>;
  oldest:    number;
}

export type WsMessage =
  | { type: 'init';       data: InitPayload }
  | { type: 'connection'; data: Connection }
  | { type: 'stats';      data: Record<string, number> };
