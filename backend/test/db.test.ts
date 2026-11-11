import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// db.ts opens the database on import: point it at a throwaway file first
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'globegate-test-')), 'test.db');
const { insertConnection, queryWindow, queryDensity } = await import('../src/db.js');

const T0 = 1_700_000_000_000;
const routers = ['jellyfin', 'immich', 'ssh'];
for (let i = 0; i < 1000; i++) {
  insertConnection({
    id: '', ip: '203.0.113.1', router: routers[i % 3]!, status: 200, method: 'GET', path: '/',
    proto: i % 3 === 2 ? 'tcp' : 'http', port: i % 3 === 2 ? 22 : 0, color: 'hsl(0,0%,50%)',
    source: { lat: 0, lon: 0 }, target: { lat: 0, lon: 0 },
    city: '', country: i % 2 ? 'France' : 'Japan', countryCode: i % 2 ? 'FR' : 'JP',
    timestamp: new Date(T0 + i * 1000).toISOString(),
  });
}

test('queryWindow samples evenly across the whole window and reports exact totals', () => {
  const w = queryWindow(T0, T0 + 1_000_000, 100);
  assert.equal(w.total, 1000);
  assert.equal(w.rows.length, 100);
  const ts = w.rows.map(r => Date.parse(r.timestamp));
  assert.equal(ts[0], T0, 'starts at the beginning of the window');
  assert.ok(ts.at(-1)! >= T0 + 980_000, 'reaches the end of the window');
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'oldest first');
  assert.deepEqual(w.byRouter, { jellyfin: 334, immich: 333, ssh: 333 });
  assert.deepEqual(w.byProto, { http: 667, tcp: 333 });
  assert.deepEqual(w.byCountry.map(c => `${c.cc}:${c.n}`).sort(), ['FR:500', 'JP:500']);
});

test('queryWindow returns everything when under the limit, and the end is exclusive', () => {
  const w = queryWindow(T0, T0 + 10_000, 100);
  assert.equal(w.total, 10);
  assert.equal(w.rows.length, 10);
  assert.equal(queryWindow(T0 + 2_000_000, T0 + 3_000_000, 100).total, 0);
});

test('queryDensity counts rows per equal slice', () => {
  assert.deepEqual(queryDensity(T0, T0 + 1_000_000, 10), Array(10).fill(100));
  assert.deepEqual(queryDensity(T0, T0, 5), [0, 0, 0, 0, 0]);
  assert.throws(() => queryDensity(T0, T0 + 1, 0), RangeError);
  assert.throws(() => queryDensity(T0, T0 + 1, 201), RangeError);
});
