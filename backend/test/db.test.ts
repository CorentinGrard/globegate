import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// db.ts opens the database on import: point it at a throwaway file first
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'globegate-test-')), 'test.db');
const { insertConnection, queryWindow, querySummary, queryDensity } = await import('../src/db.js');

const T0 = 1_700_000_000_000;
const routers = ['jellyfin', 'immich', 'ssh'];
for (let i = 0; i < 1000; i++) {
  insertConnection({
    id: '', ip: '203.0.113.1', router: routers[i % 3]!, status: 200, method: 'GET', path: '/',
    proto: i % 3 === 2 ? 'tcp' : 'http', port: i % 3 === 2 ? 22 : 0, color: 'hsl(0,0%,50%)',
    source: { lat: 0, lon: 0 }, target: { lat: 0, lon: 0 },
    city: '', country: i % 2 ? 'France' : 'Japan', countryCode: i % 2 ? 'FR' : 'JP', asn: 0, org: '', blocked: false,
    timestamp: new Date(T0 + i * 1000).toISOString(),
  });
}

test('queryWindow samples evenly across the whole window', () => {
  const w = queryWindow(T0, T0 + 1_000_000, 100);
  assert.equal(w.total, 1000);
  assert.equal(w.rows.length, 100);
  const ts = w.rows.map(r => Date.parse(r.timestamp));
  assert.equal(ts[0], T0, 'starts at the beginning of the window');
  assert.ok(ts.at(-1)! >= T0 + 980_000, 'reaches the end of the window');
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'oldest first');
  assert.equal(w.next, null, 'nothing after the last row');
});

test('queryWindow returns everything when under the limit, the end is exclusive, and points to what comes next', () => {
  const w = queryWindow(T0, T0 + 10_000, 100);
  assert.equal(w.total, 10);
  assert.equal(w.rows.length, 10);
  assert.equal(w.next, T0 + 10_000);
  const empty = queryWindow(T0 - 50_000, T0 - 1, 100);
  assert.equal(empty.total, 0);
  assert.equal(empty.next, T0, 'skips ahead to the first connection');
});

test('querySummary reports exact totals and the most active IPs', () => {
  const s = querySummary(T0, T0 + 1_000_000);
  assert.equal(s.total, 1000);
  assert.deepEqual(s.byRouter, { jellyfin: 334, immich: 333, ssh: 333 });
  assert.deepEqual(s.byProto, { http: 667, tcp: 333 });
  assert.deepEqual(s.byCountry.map(c => `${c.cc}:${c.n}`).sort(), ['FR:500', 'JP:500']);
  assert.equal(s.topIps.length, 1);
  assert.equal(s.topIps[0]!.n, 1000);
  assert.equal(Date.parse(s.topIps[0]!.timestamp), T0 + 999_000, 'described by its latest connection');
});

test('queryDensity counts rows per equal slice', () => {
  assert.deepEqual(queryDensity(T0, T0 + 1_000_000, 10), Array(10).fill(100));
  assert.deepEqual(queryDensity(T0, T0, 5), [0, 0, 0, 0, 0]);
  assert.throws(() => queryDensity(T0, T0 + 1, 0), RangeError);
  assert.throws(() => queryDensity(T0, T0 + 1, 201), RangeError);
});

test('bans: first-seen time survives updates, lifting keeps an earlier expiry, windows by start', async () => {
  const { upsertBan, getBan, endBan, queryBansInWindow, queryActiveBans } = await import('../src/db.js');
  const row = {
    id: 42, value: '198.51.100.1', scope: 'ip' as const, scenario: 'crowdsecurity/ssh-bf', origin: 'crowdsec', type: 'ban',
    start: T0, until: T0 + 4 * 3_600_000, src_lat: null, src_lon: null, city: '', country: '', cc: '', asn: 0, org: '',
  };
  upsertBan(row);
  upsertBan({ ...row, start: T0 + 50_000, until: T0 + 5 * 3_600_000 });
  assert.equal(getBan(42)!.start, T0);
  assert.equal(getBan(42)!.until, T0 + 5 * 3_600_000);
  upsertBan({ ...row, value: '192.0.2.1', start: T0 + 60_000 });
  assert.equal(getBan(42)!.start, T0 + 60_000, 'a reused id is a new decision');

  endBan(42, T0 + 120_000);
  assert.equal(getBan(42)!.until, T0 + 120_000);
  endBan(42, T0 + 999_999_999);
  assert.equal(getBan(42)!.until, T0 + 120_000, 'never extended by lifting');

  assert.deepEqual(queryBansInWindow(T0 + 60_000, T0 + 60_001).map(b => b.id), [42], 'started in the window');
  assert.deepEqual(queryBansInWindow(T0 + 100_000, T0 + 110_000).map(b => b.id), [42], 'still active in the window');
  assert.deepEqual(queryBansInWindow(T0, T0 + 60_000).map(b => b.id), [], 'not started yet');
  assert.deepEqual(queryBansInWindow(T0 + 120_000, T0 + 130_000).map(b => b.id), [], 'already lifted');
  assert.deepEqual(queryActiveBans(T0 + 100_000).map(b => b.id), [42]);
  assert.deepEqual(queryActiveBans(T0 + 200_000).map(b => b.id), []);
});
