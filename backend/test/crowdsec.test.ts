import { test } from 'node:test';
import assert from 'node:assert/strict';

// config is read on import
process.env['CROWDSEC_LAPI_URL'] = 'http://lapi.test:8080/';
process.env['CROWDSEC_API_KEY'] = 'test-key';
process.env['CROWDSEC_POLL_SECONDS'] = '2';
const { parseGoDuration, decisionToBan, pullDecisions, startCrowdSec, stopCrowdSec } = await import('../src/sources/crowdsec.js');
type Decision = import('../src/sources/crowdsec.js').Decision;

const NOW = 1_700_000_000_000;
const dec = (over: Partial<Decision> = {}): Decision => ({
  id: 1, origin: 'crowdsec', type: 'ban', scope: 'Ip', value: '203.0.113.9',
  duration: '3h59m58.5s', scenario: 'crowdsecurity/ssh-bf', ...over,
});

test('parses Go durations', () => {
  assert.equal(parseGoDuration('1h2m3.5s'), 3_723_500);
  assert.equal(parseGoDuration('150ms'), 150);
  assert.equal(parseGoDuration('-1.5s'), -1_500);
  assert.ok(Number.isNaN(parseGoDuration('4 hours')));
});

test('turns an IP decision into a ban, expiring after the remaining duration', () => {
  const b = decisionToBan(dec(), NOW, null)!;
  assert.equal(b.value, '203.0.113.9');
  assert.equal(b.scope, 'ip');
  assert.equal(b.until, NOW + 14_398_500);
  assert.equal(b.start, NOW);
  assert.equal(b.src_lat, null, 'no location without GeoIP');
});

test('prefers the explicit until date and keeps ranges', () => {
  const b = decisionToBan(dec({ scope: 'Range', value: '198.51.100.0/24', until: '2023-11-15T00:00:00Z' }), NOW, null)!;
  assert.equal(b.scope, 'range');
  assert.equal(b.value, '198.51.100.0/24');
  assert.equal(b.until, Date.parse('2023-11-15T00:00:00Z'));
});

test('skips decisions that cannot be drawn or are not enforced', () => {
  assert.equal(decisionToBan(dec({ scope: 'Country', value: 'CN' }), NOW, null), null);
  assert.equal(decisionToBan(dec({ scope: 'Username', value: 'root' }), NOW, null), null);
  assert.equal(decisionToBan(dec({ value: 'not-an-ip' }), NOW, null), null);
  assert.equal(decisionToBan(dec({ simulated: true }), NOW, null), null);
});

test('calls the decision stream with the key, scopes and origins', async () => {
  let url = '';
  let headers: Record<string, string> = {};
  const fake = (async (u: string, init: RequestInit) => {
    url = u; headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ new: null, deleted: null }), { status: 200 });
  }) as typeof fetch;
  const r = await pullDecisions(true, fake);
  assert.deepEqual(r, { new: [], deleted: [] });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'http://lapi.test:8080/v1/decisions/stream');
  assert.equal(u.searchParams.get('startup'), 'true');
  assert.equal(u.searchParams.get('scopes'), 'ip,range');
  assert.equal(u.searchParams.get('origins'), 'crowdsec,cscli,console');
  assert.equal(headers['X-Api-Key'], 'test-key');
});

test('explains a rejected key', async () => {
  const fake = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(pullDecisions(false, fake), /API key rejected/);
});

test('syncs the full list first, then applies changes', async () => {
  const replies = [
    { new: [dec({ id: 1 }), dec({ id: 2, value: '198.51.100.7' }), dec({ id: 3, origin: 'CAPI' })], deleted: [] },
    { new: [dec({ id: 4, value: '192.0.2.44' })], deleted: [dec({ id: 1 })] },
  ];
  const startups: string[] = [];
  const fake = (async (u: string) => {
    startups.push(new URL(u).searchParams.get('startup')!);
    return new Response(JSON.stringify(replies.shift() ?? { new: [], deleted: [] }));
  }) as typeof fetch;

  const events: string[] = [];
  const done = new Promise<void>(resolve => {
    startCrowdSec({
      sync:   rows => events.push(`sync:${rows.map(r => r.id).join(',')}`),
      added:  row => { events.push(`add:${row.id}`); },
      lifted: id => { events.push(`lift:${id}`); stopCrowdSec(); resolve(); },
      online: up => events.push(`online:${up}`),
    }, fake);
  });
  await done;
  assert.deepEqual(startups.slice(0, 2), ['true', 'false']);
  assert.deepEqual(events, ['sync:1,2', 'online:true', 'lift:1', 'add:4'], 'CAPI decisions are left out');
});
