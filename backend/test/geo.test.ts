import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A city database that isn't a MaxMind file, and no ASN database at all
const dir = mkdtempSync(join(tmpdir(), 'globegate-geo-'));
writeFileSync(join(dir, 'GeoLite2-City.mmdb'), 'not a database');
process.env['GEOIP_DB_PATH'] = join(dir, 'GeoLite2-City.mmdb');
const { geolocate, hasGeoIP, initGeoIP, lookupAsn } = await import('../src/geo.js');

test('lookups degrade to "unknown" without a usable database', async () => {
  assert.equal(hasGeoIP(), false);
  assert.equal(geolocate('8.8.8.8'), null);
  assert.deepEqual(lookupAsn('8.8.8.8'), { asn: 0, org: '' });

  await initGeoIP(); // a broken file is reported, not thrown
  assert.equal(hasGeoIP(), false);
  assert.equal(geolocate('8.8.8.8'), null);
  assert.deepEqual(lookupAsn('not an ip'), { asn: 0, org: '' });
});
