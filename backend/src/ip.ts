// ─────────────────────────────────────────────
//  IP address helpers
// ─────────────────────────────────────────────
import { BlockList, isIP } from 'net';

/** Strip brackets, zone ids and the IPv4-mapped IPv6 prefix: "[::ffff:1.2.3.4]" → "1.2.3.4" */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  ip = ip.split('%')[0]!;
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for addresses that never come from the public internet (or aren't IPs at all). */
export function isPrivateIP(raw: string): boolean {
  const ip = normalizeIp(raw);
  const v = isIP(ip);
  if (!v) return true;
  return PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Build a matcher for a list of IPs / CIDR ranges ("1.2.3.4", "10.0.0.0/8", "2001:db8::/32").
 * Invalid entries are reported through `onInvalid` and skipped.
 */
export function createIpMatcher(entries: string[], onInvalid?: (entry: string) => void): (ip: string) => boolean {
  const list = new BlockList();
  let count = 0;
  for (const entry of entries) {
    const [addr = '', bitsRaw] = entry.split('/');
    const ip = normalizeIp(addr);
    const v = isIP(ip);
    const type = v === 4 ? 'ipv4' : 'ipv6';
    const bits = bitsRaw === undefined ? (v === 4 ? 32 : 128) : Number(bitsRaw);
    if (!v || !Number.isInteger(bits) || bits < 0 || bits > (v === 4 ? 32 : 128)) {
      onInvalid?.(entry);
      continue;
    }
    list.addSubnet(ip, bits, type);
    count++;
  }
  if (!count) return () => false;
  return raw => {
    const ip = normalizeIp(raw);
    const v = isIP(ip);
    return v ? list.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
  };
}

/** Hide the host part of an address: IPv4 → "203.0.113.x", IPv6 → first 48 bits + "::/48". */
export function maskIp(raw: string): string {
  const ip = normalizeIp(raw);
  const v = isIP(ip);
  if (v === 4) return ip.split('.').slice(0, 3).join('.') + '.x';
  if (v === 6) {
    const [head = '', tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const fill = ip.includes('::') ? Array(8 - headParts.length - tailParts.length).fill('0') : [];
    const groups = [...headParts, ...fill, ...tailParts];
    return groups.slice(0, 3).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/48';
  }
  return '';
}
