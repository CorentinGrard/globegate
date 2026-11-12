import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'globegate-visitor-')), 'test.db');
process.env['IP_DISPLAY'] = 'hidden';
const { insertConnection, upsertBan } = await import('../src/db.js');
const { visitorDetails } = await import('../src/visitor.js');
type BanRow = import('../src/db.js').BanRow;

const now = Date.now();
const ban = (over: Partial<BanRow>): BanRow => ({
  id: 1, value: '198.51.100.20', scope: 'ip', scenario: 'crowdsecurity/ssh-bf', origin: 'crowdsec', type: 'ban',
  start: now - 60_000, until: now + 3_600_000, src_lat: 52.37, src_lon: 4.9, city: 'Amsterdam', country: 'Netherlands',
  cc: 'NL', asn: 14061, org: 'DigitalOcean, LLC', ...over,
});

test('a banned IP that never connected is placed where the ban says', () => {
  upsertBan(ban({}));
  const d = visitorDetails({ ban: 1 })!;
  assert.equal(d.total, 0);
  assert.equal(d.city, 'Amsterdam');
  assert.deepEqual(d.source, { lat: 52.37, lon: 4.9 });
  assert.equal(d.bans.length, 1);
});

test('IP_DISPLAY=hidden never reveals the address, even in details', () => {
  const d = visitorDetails({ ban: 1 })!;
  assert.equal(d.ip, '');
  assert.ok(d.bans.every(b => b.ip === ''));
});

test('range bans covering a visitor are listed with its own bans, newest first', () => {
  upsertBan(ban({ id: 2, value: '198.51.100.0/24', scope: 'range', start: now - 10_000 }));
  upsertBan(ban({ id: 3, value: '203.0.113.0/24', scope: 'range', start: now - 5_000 }));
  const id = insertConnection({
    id: '', ip: '198.51.100.20', router: 'ssh', status: 0, method: '', path: '', proto: 'tcp', port: 22, color: '',
    source: { lat: 1, lon: 2 }, target: { lat: 0, lon: 0 }, city: 'Utrecht', country: 'Netherlands', countryCode: 'NL',
    asn: 0, org: '', blocked: true, timestamp: new Date(now).toISOString(),
  });
  const d = visitorDetails({ conn: id })!;
  assert.deepEqual(d.bans.map(b => b.id), ['2', '1'], 'covering range first (newer), unrelated range left out');
  assert.equal(d.city, 'Utrecht', 'the latest connection wins over the ban location');
  assert.equal(d.total, 1);
});

test('unknown ids give nothing', () => {
  assert.equal(visitorDetails({ ban: 404 }), null);
  assert.equal(visitorDetails({ conn: 404 }), null);
  assert.equal(visitorDetails({}), null);
});
