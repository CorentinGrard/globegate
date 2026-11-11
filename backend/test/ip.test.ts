import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpMatcher, isPrivateIP, maskIp, normalizeIp } from '../src/ip.js';

test('normalizeIp strips brackets, zones and IPv4-mapped prefixes', () => {
  assert.equal(normalizeIp('[2001:DB8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
});

test('isPrivateIP', () => {
  for (const ip of ['10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.255.255', '127.0.0.1',
    '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip', '']) {
    assert.equal(isPrivateIP(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIP(ip), false, ip);
  }
});

test('maskIp hides the host part', () => {
  assert.equal(maskIp('203.0.113.42'), '203.0.113.x');
  assert.equal(maskIp('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
  assert.equal(maskIp('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(maskIp('garbage'), '');
});

test('createIpMatcher supports single IPs and CIDR ranges, v4 and v6', () => {
  const invalid: string[] = [];
  const m = createIpMatcher(['203.0.113.7', '198.51.100.0/24', '2001:db8::/32', 'nope', '1.2.3.4/40'], e => invalid.push(e));
  assert.deepEqual(invalid, ['nope', '1.2.3.4/40']);
  assert.equal(m('203.0.113.7'), true);
  assert.equal(m('203.0.113.8'), false);
  assert.equal(m('198.51.100.200'), true);
  assert.equal(m('2001:db8:1::5'), true);
  assert.equal(m('2001:db9::5'), false);
  assert.equal(createIpMatcher([])('1.2.3.4'), false);
});
