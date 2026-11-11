// ─────────────────────────────────────────────
//  Source: demo traffic (fake connections from real cities)
// ─────────────────────────────────────────────
import type { GeoResult, ParsedLine } from '../types.js';

// [lat, lon, city, country, ISO code]
const CITIES: [number, number, string, string, string][] = [
  [48.85,   2.35,  'Paris',          'France',         'FR'],
  [51.51,  -0.13,  'London',         'United Kingdom', 'GB'],
  [52.52,  13.40,  'Berlin',         'Germany',        'DE'],
  [41.90,  12.50,  'Rome',           'Italy',          'IT'],
  [40.42,  -3.70,  'Madrid',         'Spain',          'ES'],
  [48.21,  16.37,  'Vienna',         'Austria',        'AT'],
  [59.33,  18.07,  'Stockholm',      'Sweden',         'SE'],
  [60.17,  24.94,  'Helsinki',       'Finland',        'FI'],
  [53.34,  -6.27,  'Dublin',         'Ireland',        'IE'],
  [47.38,   8.54,  'Zurich',         'Switzerland',    'CH'],
  [52.37,   4.90,  'Amsterdam',      'Netherlands',    'NL'],
  [38.72,  -9.14,  'Lisbon',         'Portugal',       'PT'],
  [50.06,  19.94,  'Krakow',         'Poland',         'PL'],
  [40.71, -74.01,  'New York',       'United States',  'US'],
  [34.05,-118.24,  'Los Angeles',    'United States',  'US'],
  [41.88, -87.63,  'Chicago',        'United States',  'US'],
  [47.61,-122.33,  'Seattle',        'United States',  'US'],
  [25.77, -80.19,  'Miami',          'United States',  'US'],
  [43.65, -79.38,  'Toronto',        'Canada',         'CA'],
  [45.50, -73.57,  'Montreal',       'Canada',         'CA'],
  [19.43, -99.13,  'Mexico City',    'Mexico',         'MX'],
  [35.69, 139.69,  'Tokyo',          'Japan',          'JP'],
  [37.57, 126.98,  'Seoul',          'South Korea',    'KR'],
  [31.23, 121.47,  'Shanghai',       'China',          'CN'],
  [22.28, 114.16,  'Hong Kong',      'Hong Kong',      'HK'],
  [ 1.35, 103.82,  'Singapore',      'Singapore',      'SG'],
  [13.75, 100.52,  'Bangkok',        'Thailand',       'TH'],
  [28.61,  77.21,  'Delhi',          'India',          'IN'],
  [19.08,  72.88,  'Mumbai',         'India',          'IN'],
  [21.03, 105.83,  'Hanoi',          'Vietnam',        'VN'],
  [41.01,  28.95,  'Istanbul',       'Turkey',         'TR'],
  [25.20,  55.27,  'Dubai',          'UAE',            'AE'],
  [-23.55, -46.63, 'São Paulo',      'Brazil',         'BR'],
  [-34.61, -58.38, 'Buenos Aires',   'Argentina',      'AR'],
  [-12.05, -77.04, 'Lima',           'Peru',           'PE'],
  [  4.71, -74.07, 'Bogotá',         'Colombia',       'CO'],
  [-33.46, -70.65, 'Santiago',       'Chile',          'CL'],
  [ 30.06,  31.25, 'Cairo',          'Egypt',          'EG'],
  [  6.45,   3.40, 'Lagos',          'Nigeria',        'NG'],
  [-26.20,  28.04, 'Johannesburg',   'South Africa',   'ZA'],
  [ -1.29,  36.82, 'Nairobi',        'Kenya',          'KE'],
  [ 14.69, -17.44, 'Dakar',          'Senegal',        'SN'],
  [-33.87, 151.21, 'Sydney',         'Australia',      'AU'],
  [-37.81, 144.96, 'Melbourne',      'Australia',      'AU'],
  [-36.87, 174.77, 'Auckland',       'New Zealand',    'NZ'],
];

const ROUTERS  = ['jellyfin', 'immich', 'nextcloud', 'vaultwarden', 'homeassistant', 'outline', 'paperless', 'gitea'];
const STATUSES = [200, 200, 200, 200, 200, 204, 301, 304, 401, 404, 502];
const PATHS    = ['/', '/api/items', '/login', '/web/index.html', '/api/v1/sync', '/favicon.ico'];
const RAW: [ParsedLine['proto'], number, string][] = [
  ['tcp', 22, 'ssh'], ['udp', 51820, 'wireguard'], ['tcp', 25565, 'minecraft'], ['tcp', 32400, 'plex'],
];

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;

/** Documentation range addresses (RFC 5737) — never real people. */
function fakeIp(): string {
  const net = pick(['192.0.2', '198.51.100', '203.0.113']);
  return `${net}.${1 + Math.floor(Math.random() * 254)}`;
}

function fakeGeo(): GeoResult {
  const [lat, lon, city, country, countryCode] = pick(CITIES);
  const jitter = () => (Math.random() - 0.5) * 1.5;
  return { lat: lat + jitter(), lon: lon + jitter(), city, country, countryCode };
}

export function fakeEvent(): { line: ParsedLine; geo: GeoResult } {
  const ip = fakeIp();
  if (Math.random() < 0.25) {
    const [proto, port, router] = pick(RAW);
    return { line: { ip, router, status: 0, method: '', path: '', proto, port }, geo: fakeGeo() };
  }
  return {
    line: {
      ip, router: pick(ROUTERS), status: pick(STATUSES),
      method: Math.random() < 0.85 ? 'GET' : 'POST', path: pick(PATHS), proto: 'http', port: 0,
    },
    geo: fakeGeo(),
  };
}

/** Emit a fake connection every ~2 s. Returns a stop function. */
export function startDemo(emit: (line: ParsedLine, geo: GeoResult) => void): () => void {
  console.warn('🎭 Demo mode — generating fake traffic');
  const timer = setInterval(() => { const e = fakeEvent(); emit(e.line, e.geo); }, 2_000);
  return () => { clearInterval(timer); console.log('🎭 Demo mode stopped — a real source is now available'); };
}
