// ─────────────────────────────────────────────
//  Database — SQLite via better-sqlite3
// ─────────────────────────────────────────────
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Connection, Proto } from './types.js';
import { config } from './config.js';

// ── Open & migrate ────────────────────────────
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);

// Let deleted rows give their space back to the disk (see reclaimSpace). The
// mode can only be switched on an existing file by rebuilding it, once.
if (db.pragma('auto_vacuum', { simple: true }) !== 2) {
  const rebuilding = (db.pragma('page_count', { simple: true }) as number) > 1;
  if (rebuilding) console.log('🧹 Compacting the history database (one time, may take a moment)…');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
}
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    ip        TEXT    NOT NULL,
    router    TEXT,
    status    INTEGER,
    method    TEXT,
    path      TEXT,
    color     TEXT,
    src_lat   REAL,
    src_lon   REAL,
    city      TEXT,
    country   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON connections(ts);
`);

// Columns added after v2 — add them to existing databases
{
  const cols = new Set((db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map(c => c.name));
  if (!cols.has('proto')) db.exec(`ALTER TABLE connections ADD COLUMN proto TEXT NOT NULL DEFAULT 'http'`);
  if (!cols.has('port'))  db.exec(`ALTER TABLE connections ADD COLUMN port INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('cc'))    db.exec(`ALTER TABLE connections ADD COLUMN cc TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('asn'))   db.exec(`ALTER TABLE connections ADD COLUMN asn INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('org'))   db.exec(`ALTER TABLE connections ADD COLUMN org TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('blocked')) db.exec(`ALTER TABLE connections ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ip_ts ON connections(ip, ts);

  -- CrowdSec decisions. id is CrowdSec's decision id.
  CREATE TABLE IF NOT EXISTS bans (
    id        INTEGER PRIMARY KEY,
    value     TEXT    NOT NULL,     -- IP or CIDR range
    scope     TEXT    NOT NULL,     -- ip | range
    scenario  TEXT    NOT NULL DEFAULT '',
    origin    TEXT    NOT NULL DEFAULT '',
    type      TEXT    NOT NULL DEFAULT 'ban',
    start     INTEGER NOT NULL,     -- when GlobeGate first saw it
    until     INTEGER NOT NULL,     -- expiry, or when it was lifted
    src_lat   REAL, src_lon REAL,
    city      TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', cc TEXT NOT NULL DEFAULT '',
    asn       INTEGER NOT NULL DEFAULT 0, org TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_bans_start ON bans(start);
  CREATE INDEX IF NOT EXISTS idx_bans_value ON bans(value);
`);

// ── Prepared statements ───────────────────────
const stmtInsert = db.prepare<{
  ts: number; ip: string; router: string; status: number;
  method: string; path: string; color: string;
  src_lat: number; src_lon: number; city: string; country: string;
  proto: string; port: number; cc: string; asn: number; org: string; blocked: number;
}>(`
  INSERT INTO connections
    (ts, ip, router, status, method, path, color, src_lat, src_lon, city, country, proto, port, cc, asn, org, blocked)
  VALUES
    (@ts, @ip, @router, @status, @method, @path, @color, @src_lat, @src_lon, @city, @country, @proto, @port, @cc, @asn, @org, @blocked)
`);

// Time windows are half-open: from <= ts < to

const stmtCount = db.prepare<[number, number]>(
  'SELECT COUNT(*) AS n FROM connections WHERE ts >= ? AND ts < ?',
);

// Every `step`-th row in time order: an even sample across the whole window
const stmtSample = db.prepare<[number, number, number, number]>(`
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (ORDER BY ts) AS rn
    FROM connections WHERE ts >= ? AND ts < ?
  )
  WHERE (rn - 1) % ? = 0
  ORDER BY ts
  LIMIT ?
`);

const stmtNext = db.prepare<[number]>('SELECT MIN(ts) AS t FROM connections WHERE ts >= ?');

const stmtByRouter = db.prepare<[number, number]>(`
  SELECT router AS k, COUNT(*) AS n FROM connections
  WHERE ts >= ? AND ts < ? GROUP BY router ORDER BY n DESC LIMIT 20
`);

const stmtByCountry = db.prepare<[number, number]>(`
  SELECT country, cc, COUNT(*) AS n FROM connections
  WHERE ts >= ? AND ts < ? AND country != '' GROUP BY country, cc ORDER BY n DESC LIMIT 20
`);

const stmtByProto = db.prepare<[number, number]>(`
  SELECT proto AS k, COUNT(*) AS n FROM connections
  WHERE ts >= ? AND ts < ? GROUP BY proto
`);

// Most active IPs, described by their latest connection in the window
const stmtTopIps = db.prepare<[number, number, number]>(`
  SELECT t.n, c.* FROM (
    SELECT ip, COUNT(*) AS n, MAX(id) AS last FROM connections
    WHERE ts >= ? AND ts < ? GROUP BY ip ORDER BY n DESC LIMIT ?
  ) t JOIN connections c ON c.id = t.last
  ORDER BY t.n DESC
`);

const stmtDensity = db.prepare<{ from: number; to: number; buckets: number }>(`
  SELECT CAST((ts - @from) * @buckets / (@to - @from) AS INTEGER) AS b, COUNT(*) AS n
  FROM connections WHERE ts >= @from AND ts < @to GROUP BY b
`);

const stmtOldest = db.prepare<[]>('SELECT MIN(ts) AS t FROM connections');

const stmtPrune = db.prepare<[number]>('DELETE FROM connections WHERE ts < ?');

// ── Visitor (one IP) ──
const stmtIpOfConnection = db.prepare<[number]>('SELECT ip FROM connections WHERE id = ?');
const stmtVisitorSummary = db.prepare<[string]>(
  'SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM connections WHERE ip = ?',
);
const stmtVisitorRouters = db.prepare<[string]>(`
  SELECT router AS k, COUNT(*) AS n FROM connections WHERE ip = ? GROUP BY router ORDER BY n DESC LIMIT 12
`);
const stmtVisitorStatus = db.prepare<[string]>(`
  SELECT status AS k, COUNT(*) AS n FROM connections WHERE ip = ? AND proto = 'http' GROUP BY status ORDER BY n DESC
`);
const stmtVisitorPorts = db.prepare<[string]>(`
  SELECT proto, port, COUNT(*) AS n FROM connections WHERE ip = ? AND proto != 'http'
  GROUP BY proto, port ORDER BY n DESC LIMIT 12
`);
const stmtVisitorActivity = db.prepare<{ ip: string; from: number; to: number; buckets: number }>(`
  SELECT CAST((ts - @from) * @buckets / (@to - @from) AS INTEGER) AS b, COUNT(*) AS n
  FROM connections WHERE ip = @ip AND ts >= @from AND ts < @to GROUP BY b
`);
const stmtVisitorRecent = db.prepare<[string, number]>(
  'SELECT * FROM connections WHERE ip = ? ORDER BY ts DESC LIMIT ?',
);

// ── Bans ──
const stmtUpsertBan = db.prepare<BanRow>(`
  INSERT INTO bans (id, value, scope, scenario, origin, type, start, until, src_lat, src_lon, city, country, cc, asn, org)
  VALUES (@id, @value, @scope, @scenario, @origin, @type, @start, @until, @src_lat, @src_lon, @city, @country, @cc, @asn, @org)
  ON CONFLICT(id) DO UPDATE SET
    -- the same decision seen again keeps its start; a reused id is a new decision
    start = CASE WHEN bans.value = excluded.value THEN bans.start ELSE excluded.start END,
    value = excluded.value, scope = excluded.scope, scenario = excluded.scenario,
    origin = excluded.origin, type = excluded.type, until = excluded.until,
    src_lat = excluded.src_lat, src_lon = excluded.src_lon, city = excluded.city,
    country = excluded.country, cc = excluded.cc, asn = excluded.asn, org = excluded.org
`);
const stmtGetBan     = db.prepare<[number]>('SELECT * FROM bans WHERE id = ?');
const stmtEndBan     = db.prepare<[number, number]>('UPDATE bans SET until = MIN(until, ?) WHERE id = ?');
const stmtActiveBans = db.prepare<[number, number]>('SELECT * FROM bans WHERE until > ? ORDER BY start DESC LIMIT ?');
const stmtBansWindow = db.prepare<[number, number, number]>(
  'SELECT * FROM bans WHERE start < ? AND until > ? ORDER BY start LIMIT ?',
);
const stmtBansForIp  = db.prepare<[string]>('SELECT * FROM bans WHERE value = ? ORDER BY start DESC LIMIT 20');
const stmtRangeBans  = db.prepare<[]>(`SELECT * FROM bans WHERE scope = 'range' ORDER BY start DESC LIMIT 500`);
const stmtPruneBans  = db.prepare<[number]>('DELETE FROM bans WHERE until < ?');

// ── Row → Connection mapping ──────────────────
interface DbRow {
  id: number; ts: number; ip: string; router: string; status: number;
  method: string; path: string; color: string;
  src_lat: number; src_lon: number; city: string; country: string;
  proto: string; port: number; cc: string; asn: number; org: string; blocked: number;
}

export interface BanRow {
  id: number; value: string; scope: 'ip' | 'range'; scenario: string; origin: string; type: string;
  start: number; until: number; src_lat: number | null; src_lon: number | null;
  city: string; country: string; cc: string; asn: number; org: string;
}

function rowToConnection(r: DbRow): Connection {
  return {
    id:        String(r.id),
    ip:        r.ip,
    router:    r.router,
    status:    r.status,
    method:    r.method,
    path:      r.path,
    proto:     (r.proto || 'http') as Connection['proto'],
    port:      r.port ?? 0,
    color:     r.color,
    source:    { lat: r.src_lat, lon: r.src_lon },
    target:    { lat: config.serverLat, lon: config.serverLon },
    city:      r.city,
    country:   r.country,
    countryCode: r.cc ?? '',
    asn:       r.asn ?? 0,
    org:       r.org ?? '',
    blocked:   !!r.blocked,
    timestamp: new Date(r.ts).toISOString(),
  };
}

// ── Public API ────────────────────────────────
/** Store a connection. Returns its row id. */
export function insertConnection(conn: Connection): number {
  const r = stmtInsert.run({
    ts:      new Date(conn.timestamp).getTime(),
    ip:      conn.ip,
    router:  conn.router,
    status:  conn.status,
    method:  conn.method,
    path:    conn.path,
    color:   conn.color,
    src_lat: conn.source.lat,
    src_lon: conn.source.lon,
    city:    conn.city,
    country: conn.country,
    proto:   conn.proto,
    port:    conn.port,
    cc:      conn.countryCode,
    asn:     conn.asn,
    org:     conn.org,
    blocked: conn.blocked ? 1 : 0,
  });
  return Number(r.lastInsertRowid);
}

export interface WindowSummary {
  total:     number;
  byRouter:  Record<string, number>;
  byCountry: { country: string; cc: string; n: number }[];
  byProto:   Record<string, number>;
  topIps:    (Connection & { n: number })[];
}

/** Totals of a time window: what the side panels show. */
export function querySummary(fromMs: number, toMs: number, topIps = 5): WindowSummary {
  const total = (stmtCount.get(fromMs, toMs) as { n: number }).n;
  const byRouter: Record<string, number> = {};
  for (const r of stmtByRouter.all(fromMs, toMs) as { k: string; n: number }[]) byRouter[r.k] = r.n;
  const byProto: Record<string, number> = {};
  for (const r of stmtByProto.all(fromMs, toMs) as { k: string; n: number }[]) byProto[r.k || 'http'] = r.n;
  const byCountry = stmtByCountry.all(fromMs, toMs) as { country: string; cc: string; n: number }[];
  const top = (stmtTopIps.all(fromMs, toMs, topIps) as (DbRow & { n: number })[]).map(r => ({ ...rowToConnection(r), n: r.n }));
  return { total, byRouter, byCountry, byProto, topIps: top };
}

/**
 * Connections to play back: up to `limit` rows spread evenly over the whole
 * window (oldest first), how many there are in total, and when the next one
 * after the window happened (so playback can skip quiet periods).
 */
export function queryWindow(fromMs: number, toMs: number, limit: number): { rows: Connection[]; total: number; next: number | null } {
  const total = (stmtCount.get(fromMs, toMs) as { n: number }).n;
  const step  = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const rows  = limit > 0 ? (stmtSample.all(fromMs, toMs, step, limit) as DbRow[]).map(rowToConnection) : [];
  const next  = (stmtNext.get(toMs) as { t: number | null }).t;
  return { rows, total, next };
}

export const MAX_DENSITY_BUCKETS = 200;

/** Connection counts in `buckets` equal slices of [from, to). */
export function queryDensity(fromMs: number, toMs: number, buckets: number): number[] {
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > MAX_DENSITY_BUCKETS) {
    throw new RangeError(`buckets must be an integer between 1 and ${MAX_DENSITY_BUCKETS}`);
  }
  const counts = new Array<number>(buckets).fill(0);
  if (!(toMs > fromMs)) return counts;
  for (const { b, n } of stmtDensity.all({ from: fromMs, to: toMs, buckets }) as { b: number; n: number }[]) {
    if (b >= 0 && b < buckets) counts[b] = n;
  }
  return counts;
}

export function queryOldest(): number {
  const row = stmtOldest.get() as { t: number | null } | undefined;
  return row?.t ?? Date.now();
}

export function pruneOldRows(): number {
  const cutoff = Date.now() - config.retentionMs;
  stmtPruneBans.run(cutoff);
  return stmtPrune.run(cutoff).changes;
}

/**
 * Return the pages freed by pruning to the filesystem, so the file shrinks with
 * the data instead of staying at its largest size. Cheap when nothing is free.
 */
export function reclaimSpace(): void {
  if ((db.pragma('freelist_count', { simple: true }) as number) === 0) return;
  db.pragma('incremental_vacuum');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** File size as SQLite sees it: used pages and free pages. */
export function dbPages(): { total: number; free: number } {
  return {
    total: db.pragma('page_count', { simple: true }) as number,
    free:  db.pragma('freelist_count', { simple: true }) as number,
  };
}

// ── Visitor ───────────────────────────────────
export const VISITOR_BUCKETS = 56; // 3-hour bars over 7 days

/** The IP behind a stored connection, or null. */
export function ipOfConnection(id: number): string | null {
  return (stmtIpOfConnection.get(id) as { ip: string } | undefined)?.ip ?? null;
}

export interface VisitorRows {
  total: number; firstSeen: number; lastSeen: number;
  byRouter: Record<string, number>;
  byStatus: Record<string, number>;
  byPort:   { proto: Proto; port: number; n: number }[];
  activity: { from: number; to: number; buckets: number[] };
  recent:   Connection[];
}

/** Everything stored about one IP. */
export function queryVisitor(ip: string, now = Date.now()): VisitorRows {
  const sum = stmtVisitorSummary.get(ip) as { n: number; first: number | null; last: number | null };
  const byRouter: Record<string, number> = {};
  for (const r of stmtVisitorRouters.all(ip) as { k: string; n: number }[]) byRouter[r.k] = r.n;
  const byStatus: Record<string, number> = {};
  for (const r of stmtVisitorStatus.all(ip) as { k: number; n: number }[]) byStatus[String(r.k)] = r.n;
  const byPort = stmtVisitorPorts.all(ip) as { proto: Proto; port: number; n: number }[];

  const to = now + 1; // windows are half-open: include connections stamped right now
  const from = to - config.retentionMs;
  const buckets = new Array<number>(VISITOR_BUCKETS).fill(0);
  for (const { b, n } of stmtVisitorActivity.all({ ip, from, to, buckets: VISITOR_BUCKETS }) as { b: number; n: number }[]) {
    if (b >= 0 && b < VISITOR_BUCKETS) buckets[b] = n;
  }
  const recent = (stmtVisitorRecent.all(ip, 25) as DbRow[]).map(rowToConnection);
  return {
    total: sum.n, firstSeen: sum.first ?? 0, lastSeen: sum.last ?? 0,
    byRouter, byStatus, byPort, activity: { from, to, buckets }, recent,
  };
}

// ── Bans ──────────────────────────────────────
export function upsertBan(b: BanRow): void { stmtUpsertBan.run(b); }
export function getBan(id: number): BanRow | null { return (stmtGetBan.get(id) as BanRow | undefined) ?? null; }
/** Mark a decision as lifted at `at` (keeps an earlier expiry). */
export function endBan(id: number, at: number): void { stmtEndBan.run(at, id); }
export function queryActiveBans(now = Date.now(), limit = 1_000): BanRow[] {
  return stmtActiveBans.all(now, limit) as BanRow[];
}
/** Decisions active at some point in [from, to), oldest first. */
export function queryBansInWindow(fromMs: number, toMs: number, limit = 200): BanRow[] {
  return stmtBansWindow.all(toMs, fromMs, limit) as BanRow[]; // start < to AND until > from
}
/** Decisions against exactly this IP, plus range decisions (filtered by the caller). */
export function queryBansForIp(ip: string): { exact: BanRow[]; ranges: BanRow[] } {
  return { exact: stmtBansForIp.all(ip) as BanRow[], ranges: stmtRangeBans.all() as BanRow[] };
}

export function closeDb(): void {
  db.close();
}
