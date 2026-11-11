import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPathMatcher, HostIpSet, looksLikeSecret, redactPath, REDACTED } from '../src/filters.js';

test('redactPath masks token-like segments', () => {
  const hex = 'a1e0411d1124bee318d93362622d761d5fee5f814628a1fe51c1f6e9ce884371';
  assert.equal(redactPath(`/api/webhook/${hex}`), `/api/webhook/${REDACTED}`);
  assert.equal(redactPath('/share/550e8400-e29b-41d4-a716-446655440000/view'), `/share/${REDACTED}/view`);
  assert.equal(redactPath('/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'), `/reset/${REDACTED}`);
});

test('redactPath keeps ordinary paths', () => {
  for (const p of [
    '/', '/web/index.html', '/api/v1/status', '/.well-known/openid-configuration',
    '/blog/how-to-configure-traefik-2024-guide', '/items/12345678901234567890', '/api/server/ping',
  ]) assert.equal(redactPath(p), p, p);
  assert.equal(looksLikeSecret('Videos2024'), false);
});

test('createPathMatcher matches prefixes', () => {
  const m = createPathMatcher(['/health', 'alive', '/api/server/ping']);
  assert.equal(m('/health'), true);
  assert.equal(m('/healthz'), true);
  assert.equal(m('/alive'), true);
  assert.equal(m('/api/server/ping'), true);
  assert.equal(m('/api/server/info'), false);
  assert.equal(createPathMatcher([])('/health'), false);
});

test('HostIpSet resolves hosts and keeps old addresses when DNS fails', async () => {
  let fail = false;
  const set = new HostIpSet(['home.example'], async () => {
    if (fail) throw new Error('SERVFAIL');
    return ['203.0.113.7', '2001:db8::7'];
  });
  assert.equal(set.has('203.0.113.7'), false);
  await set.refresh();
  assert.equal(set.has('203.0.113.7'), true);
  assert.equal(set.has('::ffff:203.0.113.7'), true);
  assert.equal(set.has('2001:db8::7'), true);
  fail = true;
  await set.refresh();
  assert.equal(set.has('203.0.113.7'), true);
});
