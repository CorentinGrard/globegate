import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'globegate-hub-')), 'test.db');
process.env['IP_DISPLAY'] = 'masked';
const { Hub } = await import('../src/hub.js');
const { visitorDetails } = await import('../src/visitor.js');
type WsMessage = import('../src/types.js').WsMessage;
type BanRow = import('../src/db.js').BanRow;

// Minimal stand-in for a WebSocketServer with one open client
const sent: WsMessage[] = [];
const wss = { on: () => {}, clients: new Set([{ readyState: 1, send: (p: string) => sent.push(JSON.parse(p) as WsMessage) }]) };
const hub = new Hub(wss as never);

const geo = { lat: 48.85, lon: 2.35, city: 'Paris', country: 'France', countryCode: 'FR' };
const asn = { asn: 12322, org: 'Free SAS' };
const http = (ip: string) => ({ ip, router: 'jellyfin', status: 200, method: 'GET', path: '/web', proto: 'http' as const, port: 0 });
const ban = (over: Partial<BanRow> = {}): BanRow => ({
  id: 7, value: '198.51.100.7', scope: 'ip', scenario: 'crowdsecurity/http-probing', origin: 'crowdsec', type: 'ban',
  start: Date.now(), until: Date.now() + 3_600_000, src_lat: 1, src_lon: 2,
  city: 'Amsterdam', country: 'Netherlands', cc: 'NL', asn: 14061, org: 'DigitalOcean, LLC', ...over,
});

test('connections get their database id, ISP and a masked IP for viewers', () => {
  const c = hub.ingest(http('203.0.113.5'), geo, asn)!;
  assert.match(c.id, /^\d+$/);
  assert.equal(c.org, 'Free SAS');
  assert.equal(c.blocked, false);
  const msg = sent.at(-1)!;
  assert.equal(msg.type, 'connection');
  assert.equal(msg.type === 'connection' && msg.data.ip, '203.0.113.x');
});

test('connections from a banned IP or range are flagged until the ban is lifted', () => {
  hub.addBan(ban());
  assert.equal(sent.at(-1)!.type, 'ban');
  assert.equal(hub.ingest(http('198.51.100.7'), geo, asn)!.blocked, true);
  hub.addBan(ban({ id: 8, value: '192.0.2.0/24', scope: 'range' }));
  assert.equal(hub.ingest(http('192.0.2.99'), geo, asn)!.blocked, true);
  hub.liftBan(7);
  assert.deepEqual(sent.at(-1), { type: 'unban', data: { id: '7' } });
  assert.equal(hub.ingest(http('198.51.100.7'), geo, asn)!.blocked, false);
});

test('a full sync lifts bans that are gone and keeps first-seen times', () => {
  const first = ban({ id: 9, value: '198.51.100.9', start: 1_000 });
  hub.syncBans([first]);
  hub.syncBans([{ ...first, start: 5_000, until: first.until + 60_000 }]);
  const d = visitorDetails({ ban: 9 })!;
  assert.equal(d.bans[0]!.start, new Date(1_000).toISOString(), 'start unchanged');
  assert.ok(sent.some(m => m.type === 'unban' && m.data.id === '8'), 'range ban not in the sync was lifted');
});

test('visitor details aggregate everything one IP did', () => {
  for (let i = 0; i < 3; i++) hub.ingest(http('203.0.113.77'), geo, asn);
  const id = hub.ingest({ ip: '203.0.113.77', router: 'ssh', status: 0, method: '', path: '', proto: 'tcp', port: 22 }, geo, asn)!.id;
  const d = visitorDetails({ conn: Number(id) })!;
  assert.equal(d.ip, '203.0.113.x');
  assert.equal(d.total, 4);
  assert.deepEqual(d.byRouter, { jellyfin: 3, ssh: 1 });
  assert.deepEqual(d.byStatus, { 200: 3 });
  assert.deepEqual(d.byPort, [{ proto: 'tcp', port: 22, n: 1 }]);
  assert.equal(d.org, 'Free SAS');
  assert.equal(d.recent[0]!.router, 'ssh', 'newest first');
  assert.equal(d.activity.buckets.reduce((a, b) => a + b, 0), 4);
  assert.equal(visitorDetails({ conn: 999_999 }), null);
});
