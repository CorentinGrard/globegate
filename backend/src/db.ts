// ─────────────────────────────────────────────
//  Database — SQLite via better-sqlite3
// ─────────────────────────────────────────────
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Connection } from './types.js';
import { config } from './config.js';

// ── Open & migrate ────────────────────────────
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
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
}

// ── Prepared statements ───────────────────────
const stmtInsert = db.prepare<{
  ts: number; ip: string; router: string; status: number;
  method: string; path: string; color: string;
  src_lat: number; src_lon: number; city: string; country: string;
  proto: string; port: number; cc: string;
}>(`
  INSERT INTO connections
    (ts, ip, router, status, method, path, color, src_lat, src_lon, city, country, proto, port, cc)
  VALUES
    (@ts, @ip, @router, @status, @method, @path, @color, @src_lat, @src_lon, @city, @country, @proto, @port, @cc)
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

const stmtDensity = db.prepare<{ from: number; to: number; buckets: number }>(`
  SELECT CAST((ts - @from) * @buckets / (@to - @from) AS INTEGER) AS b, COUNT(*) AS n
  FROM connections WHERE ts >= @from AND ts < @to GROUP BY b
`);

const stmtOldest = db.prepare<[]>('SELECT MIN(ts) AS t FROM connections');

const stmtPrune = db.prepare<[number]>('DELETE FROM connections WHERE ts < ?');

// ── Row → Connection mapping ──────────────────
interface DbRow {
  id: number; ts: number; ip: string; router: string; status: number;
  method: string; path: string; color: string;
  src_lat: number; src_lon: number; city: string; country: string;
  proto: string; port: number; cc: string;
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
    timestamp: new Date(r.ts).toISOString(),
  };
}

// ── Public API ────────────────────────────────
export function insertConnection(conn: Connection): void {
  stmtInsert.run({
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
  });
}

export interface WindowSummary {
  total:     number;
  byRouter:  Record<string, number>;
  byCountry: { country: string; cc: string; n: number }[];
  byProto:   Record<string, number>;
}

/**
 * A time window for replay: up to `limit` rows spread evenly over the whole
 * window (oldest first), plus exact totals for everything in it.
 */
export function queryWindow(fromMs: number, toMs: number, limit: number): { rows: Connection[] } & WindowSummary {
  const total = (stmtCount.get(fromMs, toMs) as { n: number }).n;
  const step  = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const rows  = (stmtSample.all(fromMs, toMs, step, limit) as DbRow[]).map(rowToConnection);
  const byRouter: Record<string, number> = {};
  for (const r of stmtByRouter.all(fromMs, toMs) as { k: string; n: number }[]) byRouter[r.k] = r.n;
  const byProto: Record<string, number> = {};
  for (const r of stmtByProto.all(fromMs, toMs) as { k: string; n: number }[]) byProto[r.k || 'http'] = r.n;
  const byCountry = stmtByCountry.all(fromMs, toMs) as { country: string; cc: string; n: number }[];
  return { rows, total, byRouter, byCountry, byProto };
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
  const result = stmtPrune.run(cutoff);
  return result.changes;
}

export function closeDb(): void {
  db.close();
}
