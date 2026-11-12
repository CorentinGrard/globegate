import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'globegate-app-'));
process.env['DB_PATH'] = join(dir, 'test.db');
process.env['IP_DISPLAY'] = 'masked';
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');

const { createApp, createWebSocketServer } = await import('../src/app.js');
const { insertConnection, upsertBan } = await import('../src/db.js');
type Connection = import('../src/types.js').Connection;

const now = Date.now();
const conn = (over: Partial<Connection> = {}): Connection => ({
  id: '', ip: '203.0.113.9', router: 'jellyfin', status: 200, method: 'GET', path: '/', proto: 'http', port: 0,
  color: 'hsl(0,0%,50%)', source: { lat: 1, lon: 2 }, target: { lat: 0, lon: 0 }, city: 'Paris', country: 'France',
  countryCode: 'FR', asn: 12322, org: 'Free SAS', blocked: false, timestamp: new Date(now - 60_000).toISOString(), ...over,
});
const connId = insertConnection(conn());
insertConnection(conn({ ip: '198.51.100.4', router: 'ssh', proto: 'tcp', port: 22, status: 0, timestamp: new Date(now - 30_000).toISOString() }));
upsertBan({
  id: 3, value: '192.0.2.0/24', scope: 'range', scenario: 'manual', origin: 'cscli', type: 'ban',
  start: now - 120_000, until: now + 3_600_000, src_lat: null, src_lon: null, city: '', country: '', cc: '', asn: 0, org: '',
});

const server = createServer(createApp(dir));
createWebSocketServer(server, ['https://globe.example.com']);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

const get = async (path: string): Promise<{ status: number; headers: Headers; body: any }> => {
  const r = await fetch(base + path);
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

test('every response carries the security headers', async () => {
  for (const path of ['/', '/health', '/api/summary']) {
    const { headers } = await get(path);
    assert.match(headers.get('content-security-policy') ?? '', /default-src 'self'/, path);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-powered-by'), null);
  }
});

test('/api/summary totals the period with masked IPs', async () => {
  const { body } = await get(`/api/summary?from=${now - 3_600_000}&to=${now}`);
  assert.equal(body.total, 2);
  assert.deepEqual(body.byProto, { http: 1, tcp: 1 });
  assert.deepEqual(body.topVisitors.map((v: { ip: string }) => v.ip).sort(), ['198.51.100.x', '203.0.113.x']);
});

test('/api/history samples the window and includes bans active in it', async () => {
  const { body } = await get(`/api/history?from=${now - 3_600_000}&to=${now}&limit=1`);
  assert.equal(body.total, 2);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].ip, '203.0.113.x');
  assert.deepEqual(body.bans.map((b: { id: string }) => b.id), ['3']);
});

test('/api/history and /api/density clamp bad or huge parameters', async () => {
  const h = await get('/api/history?from=abc&to=-5&limit=99999');
  assert.equal(h.status, 200);
  const d = await get(`/api/density?from=${now - 3_600_000}&to=${now}&buckets=100000`);
  assert.equal(d.status, 200);
  assert.equal(d.body.buckets.length, 200);
  assert.equal(d.body.buckets.reduce((a: number, b: number) => a + b, 0), 2);
  const fallback = await get('/api/density?buckets=0');
  assert.equal(fallback.body.buckets.length, 80);
});

test('/api/visitor validates ids and finds connections and bans', async () => {
  const v = await get(`/api/visitor?conn=${connId}`);
  assert.equal(v.status, 200);
  assert.equal(v.headers.get('cache-control'), 'no-store');
  assert.equal(v.body.ip, '203.0.113.x');
  assert.equal(v.body.org, 'Free SAS');
  const range = await get('/api/visitor?ban=3');
  assert.equal(range.status, 200);
  assert.equal(range.body.total, 0, 'a range is not one visitor');
  assert.equal(range.body.bans[0].ip, '192.0.2.0/24');
  for (const q of ['', '?conn=abc', '?conn=1e3', '?conn=99999999999999999', '?conn=424242', '?ban=1&conn=']) {
    assert.equal((await get(`/api/visitor${q}`)).status, 404, q);
  }
});

const openWs = (headers: Record<string, string>): Promise<'open' | number> => new Promise(resolve => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
  ws.on('error', () => resolve(0));
});

test('/ws accepts the dashboard and refuses other websites', async () => {
  const host = new URL(base).host;
  assert.equal(await openWs({}), 'open', 'no Origin: not a browser');
  assert.equal(await openWs({ Origin: base }), 'open', 'same origin');
  assert.equal(await openWs({ Origin: 'https://globe.example.com' }), 'open', 'ALLOWED_ORIGINS');
  assert.equal(await openWs({ Origin: 'https://evil.example' }), 401);
  assert.equal(await openWs({ Origin: 'https://evil.example', Host: host }), 401);
});
