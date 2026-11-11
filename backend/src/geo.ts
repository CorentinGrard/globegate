// ─────────────────────────────────────────────
//  GeoIP lookup via MaxMind GeoLite2-City (+ optional GeoLite2-ASN)
// ─────────────────────────────────────────────
import * as maxmind from 'maxmind';
import { existsSync } from 'fs';
import type { AsnResponse, CityResponse } from 'maxmind';
import type { AsnResult, GeoResult } from './types.js';
import { config } from './config.js';

let reader: maxmind.Reader<CityResponse> | null = null;
let asnReader: maxmind.Reader<AsnResponse> | null = null;

/** Open a database once it exists. watchForUpdates reloads it when geoip-update.sh replaces it. */
async function tryOpen<T extends maxmind.Response>(path: string, label: string): Promise<maxmind.Reader<T> | null> {
  if (!existsSync(path)) return null;
  try {
    const r = await maxmind.open<T>(path, { watchForUpdates: true });
    console.log(`✅ ${label} database loaded (${path})`);
    return r;
  } catch (err) {
    console.error(`❌ Could not open ${label} database:`, (err as Error).message);
    return null;
  }
}

/**
 * Load the GeoIP databases. If they aren't there yet (first start, still
 * downloading) keep checking in the background and pick them up as they appear.
 * The ASN database is optional: without it, ISP names are just left out.
 */
export async function initGeoIP(): Promise<void> {
  reader    = await tryOpen<CityResponse>(config.geoipDb, 'GeoIP');
  asnReader = await tryOpen<AsnResponse>(config.geoipAsnDb, 'ISP (ASN)');
  if (!reader) console.warn(`⚠️  GeoIP database not found at ${config.geoipDb} — waiting for it (connections can't be placed until then)`);
  if (reader && asnReader) return;

  const timer = setInterval(() => {
    void (async () => {
      reader    ??= await tryOpen<CityResponse>(config.geoipDb, 'GeoIP');
      asnReader ??= await tryOpen<AsnResponse>(config.geoipAsnDb, 'ISP (ASN)');
      if (reader && asnReader) clearInterval(timer);
    })();
  }, 15_000);
  timer.unref();
}

export function hasGeoIP(): boolean { return reader !== null; }

export function geolocate(ip: string): GeoResult | null {
  if (!reader) return null;
  try {
    const r = reader.get(ip);
    if (!r?.location) return null;
    return {
      lat:         r.location.latitude,
      lon:         r.location.longitude,
      city:        r.city?.names?.en ?? '',
      country:     r.country?.names?.en ?? r.registered_country?.names?.en ?? r.country?.iso_code ?? '',
      countryCode: r.country?.iso_code ?? r.registered_country?.iso_code ?? '',
    };
  } catch {
    return null;
  }
}

/** Network owner of an address ("Free SAS", "Amazon.com, Inc."…). */
export function lookupAsn(ip: string): AsnResult {
  try {
    const r = asnReader?.get(ip);
    return { asn: r?.autonomous_system_number ?? 0, org: r?.autonomous_system_organization ?? '' };
  } catch {
    return { asn: 0, org: '' };
  }
}
