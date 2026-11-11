// ─────────────────────────────────────────────
//  Hub — every source feeds connections in here
// ─────────────────────────────────────────────
//  parsed event → filters → GeoIP → SQLite + in-memory stats → WebSocket clients
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { geolocate, hasGeoIP } from './geo.js';
import { getServiceColor, SERVICE_COLORS } from './colors.js';
import { insertConnection, queryOldest } from './db.js';
import { createIpMatcher, isPrivateIP, maskIp, normalizeIp } from './ip.js';
import type { Connection, GeoResult, InitPayload, ParsedLine, SourceName, WsMessage } from './types.js';

const MAX_RECENT = 300;

const isIgnored = createIpMatcher(config.ignoreIps, e => console.warn(`⚠️  IGNORE_IPS: skipping invalid entry "${e}"`));

/** What viewers are allowed to see of a connection, according to IP_DISPLAY. */
export function toPublic(c: Connection): Connection {
  if (config.ipDisplay === 'full') return c;
  return { ...c, ip: config.ipDisplay === 'masked' ? maskIp(c.ip) : '' };
}

export class Hub {
  readonly sources: SourceName[] = [];
  private readonly recent: Connection[] = [];
  private readonly stats: Record<string, number> = {};
  private statsTimer: NodeJS.Timeout | null = null;
  private warnedNoGeo = false;

  constructor(private readonly wss: WebSocketServer) {
    wss.on('connection', ws => this.sendInit(ws));
  }

  addSource(s: SourceName): void {
    if (!this.sources.includes(s)) this.sources.push(s);
  }

  removeSource(s: SourceName): void {
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
  }

  /** Ingest one event. `geo` overrides the GeoIP lookup (used by demo mode). */
  ingest(line: ParsedLine, geo?: GeoResult): Connection | null {
    const ip = normalizeIp(line.ip);
    if (isPrivateIP(ip) || isIgnored(ip)) return null;

    const loc = geo ?? geolocate(ip);
    if (!loc) {
      if (!hasGeoIP() && !this.warnedNoGeo) {
        console.warn('⚠️  Dropping connections: no GeoIP database yet (set MAXMIND_LICENSE_KEY or mount GeoLite2-City.mmdb)');
        this.warnedNoGeo = true;
      }
      return null;
    }

    const conn: Connection = {
      id:          randomUUID(),
      ip,
      router:      line.router,
      status:      line.status,
      method:      line.method,
      path:        line.path,
      proto:       line.proto,
      port:        line.port,
      color:       getServiceColor(line.router),
      source:      { lat: loc.lat, lon: loc.lon },
      target:      { lat: config.serverLat, lon: config.serverLon },
      city:        loc.city,
      country:     loc.country,
      countryCode: loc.countryCode,
      timestamp:   new Date().toISOString(),
    };

    const detail = line.proto === 'http' ? line.status : `${line.proto}/${line.port}`;
    console.log(`🌍 ${loc.country || '?'}/${loc.city || '?'} (${toPublic(conn).ip || 'hidden'}) → ${line.router} [${detail}]`);

    this.recent.push(conn);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    this.stats[conn.router] = (this.stats[conn.router] ?? 0) + 1;

    try { insertConnection(conn); }
    catch (err) { console.error('DB insert failed:', (err as Error).message); }

    this.broadcast({ type: 'connection', data: toPublic(conn) });
    this.scheduleStats();
    return conn;
  }

  private sendInit(ws: WebSocket): void {
    const data: InitPayload = {
      serverLocation:    { lat: config.serverLat, lon: config.serverLon, label: config.serverLabel },
      recentConnections: this.recent.slice(-50).map(toPublic),
      stats:             this.stats,
      serviceColors:     SERVICE_COLORS,
      oldest:            queryOldest(),
      sources:           this.sources,
      version:           config.version,
      ipDisplay:         config.ipDisplay,
    };
    ws.send(JSON.stringify({ type: 'init', data } satisfies WsMessage));
  }

  /** Service counters change on every connection — send them at most once per second. */
  private scheduleStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.broadcast({ type: 'stats', data: this.stats });
    }, 1_000);
  }

  private broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
}
