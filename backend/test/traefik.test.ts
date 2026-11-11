import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLine } from '../src/sources/traefik.js';

// Shape of a real Traefik v3 JSON access log line (headers kept)
const base = {
  ClientAddr: '203.0.113.9:51234', ClientHost: '203.0.113.9', ClientPort: '51234',
  DownstreamStatus: 200, Duration: 1234567, RequestHost: 'media.example.com',
  RequestMethod: 'GET', RequestPath: '/web/index.html?token=secret', RequestProtocol: 'HTTP/2.0',
  RouterName: 'jellyfin@docker', ServiceName: 'jellyfin@docker', entryPointName: 'websecure',
  level: 'info', msg: '', time: '2026-11-11T10:00:00+01:00',
};

test('parses a Traefik JSON line', () => {
  const p = parseLogLine(JSON.stringify(base));
  assert.deepEqual(p, {
    ip: '203.0.113.9', router: 'jellyfin', status: 200, method: 'GET',
    path: '/web/index.html', proto: 'http', port: 0,
  });
});

test('strips the query string so tokens never reach the UI', () => {
  assert.equal(parseLogLine(JSON.stringify(base))?.path, '/web/index.html');
});

test('prefers proxy headers when Traefik keeps them', () => {
  const xff = parseLogLine(JSON.stringify({ ...base, ClientHost: '10.0.0.2', 'request_X-Forwarded-For': '198.51.100.7, 10.0.0.2' }));
  assert.equal(xff?.ip, '198.51.100.7');
  const cf = parseLogLine(JSON.stringify({ ...base, 'request_Cf-Connecting-Ip': '198.51.100.8', 'request_X-Forwarded-For': '192.0.2.1' }));
  assert.equal(cf?.ip, '198.51.100.8');
});

test('falls back to ClientAddr and handles IPv6', () => {
  const p = parseLogLine(JSON.stringify({ ...base, ClientHost: undefined, ClientAddr: '[2001:db8::5]:443' }));
  assert.equal(p?.ip, '2001:db8::5');
});

test('rejects non-JSON and lines without a client address', () => {
  assert.equal(parseLogLine('127.0.0.1 - - [10/Oct/2026] "GET / HTTP/1.1" 200'), null);
  assert.equal(parseLogLine('{not json'), null);
  assert.equal(parseLogLine(JSON.stringify({ RouterName: 'x' })), null);
});
