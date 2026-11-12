import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, esc, flag, load, save, serviceColor } from '../src/util.ts';
// The backend picks the same colours; both must agree
import { getServiceColor } from '../../backend/src/colors.ts';

test('esc neutralises HTML from log fields', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('flag turns a country code into an emoji, ignoring anything else', () => {
  assert.equal(flag('FR'), '🇫🇷');
  assert.equal(flag('jp'), '🇯🇵');
  for (const bad of ['', undefined, 'FRA', 'F1', '<b']) assert.equal(flag(bad), '', String(bad));
});

test('service colours match the backend', () => {
  for (const name of ['jellyfin', 'immich', 'ssh', 'Nextcloud', '', 'wireguard']) {
    assert.equal(serviceColor(name), getServiceColor(name), name);
  }
});

test('ago', () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now - 10_000, now), 'just now');
  assert.equal(ago(now + 60_000, now), 'just now', 'clock skew');
  assert.equal(ago(now - 5 * 60_000, now), '5 min ago');
  assert.equal(ago(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(ago(now - 86_400_000, now), '1 day ago');
  assert.equal(ago(now - 3 * 86_400_000, now), '3 days ago');
});

test('load/save survive a missing or broken localStorage', () => {
  assert.equal(load('k', 7), 7); // no localStorage in Node: falls back
  save('k', 1);                  // and doesn't throw
});
