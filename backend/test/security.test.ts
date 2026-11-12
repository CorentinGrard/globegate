import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SECURITY_POLICY, isAllowedOrigin } from '../src/security.js';

test('WebSocket origin: same host, proxy host or listed origins only', () => {
  // Not a browser: no cookies to ride on
  assert.equal(isAllowedOrigin({ host: 'globe.lan' }), true);
  // The dashboard itself, directly or behind a proxy that keeps the Host
  assert.equal(isAllowedOrigin({ origin: 'https://globe.lan', host: 'globe.lan' }), true);
  assert.equal(isAllowedOrigin({ origin: 'http://localhost:5173', host: 'localhost:5173' }), true);
  assert.equal(isAllowedOrigin({ origin: 'https://Globe.LAN', host: 'globe.lan' }), true, 'host names are case-insensitive');
  // Proxy that rewrites Host but sets X-Forwarded-Host
  assert.equal(isAllowedOrigin({ origin: 'https://globe.example.com', host: '172.16.0.1:3000', 'x-forwarded-host': 'globe.example.com' }), true);
  // Another website the user happens to visit
  assert.equal(isAllowedOrigin({ origin: 'https://evil.example', host: 'globe.lan' }), false);
  assert.equal(isAllowedOrigin({ origin: 'https://globe.lan.evil.example', host: 'globe.lan' }), false);
  assert.equal(isAllowedOrigin({ origin: 'https://globe.lan:8443', host: 'globe.lan' }), false, 'the port is part of the origin');
  assert.equal(isAllowedOrigin({ origin: 'null', host: 'globe.lan' }), false, 'sandboxed frames and files');
  assert.equal(isAllowedOrigin({ origin: 'file://globe.lan', host: 'globe.lan' }), false);
  assert.equal(isAllowedOrigin({ origin: 'https://globe.lan' }), false, 'no Host to compare with');
  // ALLOWED_ORIGINS
  const allowed = ['https://globe.example.com/'];
  assert.equal(isAllowedOrigin({ origin: 'https://globe.example.com', host: '172.16.0.1:3000' }, allowed), true);
  assert.equal(isAllowedOrigin({ origin: 'http://globe.example.com', host: '172.16.0.1:3000' }, allowed), false, 'scheme must match');
});

test('CSP only allows the page\'s own files', () => {
  const d = Object.fromEntries(CONTENT_SECURITY_POLICY.split('; ').map(p => [p.split(' ')[0], p]));
  assert.equal(d['script-src'], "script-src 'self'");
  assert.equal(d['style-src'], "style-src 'self'");
  assert.equal(d['connect-src'], "connect-src 'self'");
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-|\*/);
});
