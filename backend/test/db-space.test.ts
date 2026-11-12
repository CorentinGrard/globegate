import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A database from v1.0.0: no auto_vacuum, already holding rows
const path = join(mkdtempSync(join(tmpdir(), 'globegate-space-')), 'old.db');
{
  const old = new Database(path);
  old.pragma('journal_mode = WAL');
  old.exec(`CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ip TEXT NOT NULL,
    router TEXT, status INTEGER, method TEXT, path TEXT, color TEXT, src_lat REAL, src_lon REAL, city TEXT, country TEXT)`);
  old.prepare('INSERT INTO connections (ts, ip, router) VALUES (?, ?, ?)').run(1, '203.0.113.1', 'kept');
  assert.equal(old.pragma('auto_vacuum', { simple: true }), 0);
  old.close();
}

process.env['DB_PATH'] = path;
process.env['RETENTION_DAYS'] = '1';
const { closeDb, dbPages, insertConnection, pruneOldRows, queryOldest, reclaimSpace } = await import('../src/db.js');

const fileSize = (): number => statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0);

test('an existing database is converted on open and keeps its rows', () => {
  const check = new Database(path, { readonly: true });
  assert.equal(check.pragma('auto_vacuum', { simple: true }), 2, 'incremental');
  check.close();
  assert.equal(queryOldest(), 1);
});

test('pruned rows give their space back to the disk', () => {
  const old = Date.now() - 3 * 86_400_000;
  for (let i = 0; i < 5_000; i++) {
    insertConnection({
      id: '', ip: '198.51.100.1', router: 'r', status: 200, method: 'GET', path: '/'.padEnd(200, 'x'), proto: 'http', port: 0,
      color: '', source: { lat: 0, lon: 0 }, target: { lat: 0, lon: 0 }, city: '', country: '', countryCode: '',
      asn: 0, org: '', blocked: false, timestamp: new Date(old + i).toISOString(),
    });
  }
  reclaimSpace();
  const full = fileSize();
  assert.ok(pruneOldRows() >= 5_000);
  assert.ok(dbPages().free > 0, 'deleting leaves free pages');
  reclaimSpace();
  assert.equal(dbPages().free, 0);
  assert.ok(fileSize() < full / 3, `file shrank (${full} → ${fileSize()} bytes)`);
  reclaimSpace(); // nothing to do: must not throw
  closeDb();
});
