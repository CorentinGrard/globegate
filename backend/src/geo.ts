// ─────────────────────────────────────────────
//  GeoIP lookup via MaxMind GeoLite2-City
// ─────────────────────────────────────────────
import * as maxmind from 'maxmind';
import { existsSync } from 'fs';
import type { CityResponse } from 'maxmind';
import type { GeoResult } from './types.js';
import { config } from './config.js';

let reader: maxmind.Reader<CityResponse> | null = null;

async function tryOpen(): Promise<boolean> {
  if (!existsSync(config.geoipDb)) return false;
  try {
    // watchForUpdates reloads the database when geoip-update.sh replaces it
    reader = await maxmind.open<CityResponse>(config.geoipDb, { watchForUpdates: true });
    console.log(`✅ GeoIP database loaded (${config.geoipDb})`);
    return true;
  } catch (err) {
    console.error('❌ Could not open GeoIP database:', (err as Error).message);
    return false;
  }
}

/**
 * Load the GeoIP database. If it isn't there yet (first start, still downloading)
 * keep checking in the background and pick it up as soon as it appears.
 */
export async function initGeoIP(): Promise<void> {
  if (await tryOpen()) return;
  console.warn(`⚠️  GeoIP database not found at ${config.geoipDb} — waiting for it (connections can't be placed until then)`);
  const timer = setInterval(() => {
    void tryOpen().then(ok => { if (ok) clearInterval(timer); });
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
