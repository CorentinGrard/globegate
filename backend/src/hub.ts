// ─────────────────────────────────────────────
//  Hub — every source feeds connections in here
// ─────────────────────────────────────────────
//  parsed event → filters → GeoIP → SQLite → WebSocket clients
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { geolocate, hasGeoIP, lookupAsn } from './geo.js';
import { getServiceColor, SERVICE_COLORS } from './colors.js';
import {
  endBan, insertConnection, queryActiveBans, queryOldest, upsertBan, type BanRow,
} from './db.js';
import { createIpMatcher, isPrivateIP, normalizeIp } from './ip.js';
import { createPathMatcher, HostIpSet } from './filters.js';
import { toPublic, toPublicBan } from './public.js';
import type { AsnResult, Connection, GeoResult, InitPayload, ParsedLine, SourceName, WsMessage } from './types.js';

export { toPublic, toPublicBan } from './public.js';

const MAX_RECENT = 300;

const isIgnored     = createIpMatcher(config.ignoreIps, e => console.warn(`⚠️  IGNORE_IPS: skipping invalid entry "${e}"`));
const isIgnoredPath = createPathMatcher(config.ignorePaths);
const ownIps        = new HostIpSet(config.ignoreHosts);
ownIps.start();

export class Hub {
  readonly sources: SourceName[] = [];
  private readonly recent: Connection[] = [];
  private warnedNoGeo = false;

  // Active CrowdSec decisions, to flag connections from banned IPs
  private readonly bans = new Map<number, BanRow>();
  private bannedIps = new Map<string, number>();        // ip → latest expiry
  private inBannedRange: (ip: string) => boolean = () => false;

  constructor(private readonly wss: WebSocketServer) {
    wss.on('connection', ws => this.sendInit(ws));
    // Bans still active from before a restart
    for (const b of queryActiveBans()) this.bans.set(b.id, b);
    this.reindexBans();
  }

  addSource(s: SourceName): void {
    if (!this.sources.includes(s)) this.sources.push(s);
  }

  removeSource(s: SourceName): void {
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
  }

  /** Ingest one event. `geo` / `asn` override the lookups (used by demo mode). */
  ingest(line: ParsedLine, geo?: GeoResult, asn?: AsnResult): Connection | null {
    const ip = normalizeIp(line.ip);
    if (isPrivateIP(ip) || isIgnored(ip) || ownIps.has(ip)) return null;
    if (line.proto === 'http' && isIgnoredPath(line.path)) return null;

    const loc = geo ?? geolocate(ip);
    if (!loc) {
      if (!hasGeoIP() && !this.warnedNoGeo) {
        console.warn('⚠️  Dropping connections: no GeoIP database yet (set MAXMIND_LICENSE_KEY or mount GeoLite2-City.mmdb)');
        this.warnedNoGeo = true;
      }
      return null;
    }
    const net = asn ?? lookupAsn(ip);

    const conn: Connection = {
      id:          '',
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
      asn:         net.asn,
      org:         net.org,
      blocked:     this.isBanned(ip),
      timestamp:   new Date().toISOString(),
    };

    // The row id doubles as the connection id, so the UI can ask for details
    try { conn.id = String(insertConnection(conn)); }
    catch (err) { conn.id = randomUUID(); console.error('DB insert failed:', (err as Error).message); }

    const detail = line.proto === 'http' ? line.status : `${line.proto}/${line.port}`;
    console.log(`🌍 ${loc.country || '?'}/${loc.city || '?'} (${toPublic(conn).ip || 'hidden'}) → ${line.router} [${detail}]${conn.blocked ? ' 🛡' : ''}`);

    this.recent.push(conn);
    if (this.recent.length > MAX_RECENT) this.recent.shift();

    this.broadcast({ type: 'connection', data: toPublic(conn) });
    return conn;
  }

  // ── CrowdSec decisions ──────────────────────
  /** Replace the active list (CrowdSec's full list after connecting). */
  syncBans(rows: BanRow[]): void {
    const now = Date.now();
    const seen = new Set(rows.map(r => r.id));
    for (const id of this.bans.keys()) {
      if (!seen.has(id)) { endBan(id, now); this.bans.delete(id); this.broadcast({ type: 'unban', data: { id: String(id) } }); }
    }
    for (const r of rows) {
      const isNew = !this.bans.has(r.id);
      this.store(r);
      if (isNew) this.broadcast({ type: 'ban', data: toPublicBan(this.bans.get(r.id)!) });
    }
    this.reindexBans();
  }

  addBan(row: BanRow): void {
    const isNew = !this.bans.has(row.id);
    this.store(row);
    this.reindexBans();
    const b = this.bans.get(row.id)!;
    if (isNew) console.log(`🛡  Ban: ${toPublicBan(b).ip || 'hidden'} (${b.country || '?'}) — ${b.scenario || b.origin}`);
    this.broadcast({ type: 'ban', data: toPublicBan(b) });
  }

  liftBan(id: number): void {
    endBan(id, Date.now());
    if (!this.bans.delete(id)) return;
    this.reindexBans();
    this.broadcast({ type: 'unban', data: { id: String(id) } });
  }

  /** Persist, keeping the first-seen time of a decision we already know. */
  private store(row: BanRow): void {
    const known = this.bans.get(row.id);
    const merged = known && known.value === row.value ? { ...row, start: known.start } : row;
    try { upsertBan(merged); } catch (err) { console.error('DB ban insert failed:', (err as Error).message); }
    this.bans.set(row.id, merged);
  }

  private reindexBans(): void {
    const ips = new Map<string, number>();
    const ranges: string[] = [];
    for (const b of this.bans.values()) {
      if (b.scope === 'range') ranges.push(b.value);
      else ips.set(b.value, Math.max(ips.get(b.value) ?? 0, b.until));
    }
    this.bannedIps = ips;
    this.inBannedRange = createIpMatcher(ranges);
  }

  isBanned(ip: string): boolean {
    const until = this.bannedIps.get(ip);
    return (until !== undefined && until > Date.now()) || this.inBannedRange(ip);
  }

  private activeBans(): BanRow[] {
    const now = Date.now();
    return [...this.bans.values()].filter(b => b.until > now).sort((a, b) => b.start - a.start).slice(0, 500);
  }

  // ── WebSocket ───────────────────────────────
  private sendInit(ws: WebSocket): void {
    const data: InitPayload = {
      serverLocation:    { lat: config.serverLat, lon: config.serverLon, label: config.serverLabel },
      recentConnections: this.recent.slice(-50).map(toPublic),
      serviceColors:     SERVICE_COLORS,
      oldest:            queryOldest(),
      sources:           this.sources,
      version:           config.version,
      ipDisplay:         config.ipDisplay,
      bans:              this.activeBans().map(toPublicBan),
    };
    ws.send(JSON.stringify({ type: 'init', data } satisfies WsMessage));
  }

  private broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
}
