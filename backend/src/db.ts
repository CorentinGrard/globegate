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

const stmtSelectWindow = db.prepare<[number, number, number]>(`
  SELECT * FROM connections
  WHERE ts >= ? AND ts <= ?
  ORDER BY ts DESC
  LIMIT ?
`);

const stmtSelectAllTs = db.prepare<[number, number]>(`
  SELECT ts FROM connections
  WHERE ts >= ? AND ts <= ?
  ORDER BY ts ASC
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

export function queryHistory(fromMs: number, toMs: number, limit = 200): Connection[] {
  return (stmtSelectWindow.all(fromMs, toMs, limit) as DbRow[]).map(rowToConnection);
}

export function queryDensity(fromMs: number, toMs: number, buckets: number): number[] {
  const rows = stmtSelectAllTs.all(fromMs, toMs) as { ts: number }[];
  const counts = new Array<number>(buckets).fill(0);
  const span = toMs - fromMs;
  for (const { ts } of rows) {
    const idx = Math.min(buckets - 1, Math.floor((ts - fromMs) / span * buckets));
    counts[idx]++;
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
