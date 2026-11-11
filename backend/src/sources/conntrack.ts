// ─────────────────────────────────────────────
//  Source: conntrack — every inbound TCP/UDP connection to the host
// ─────────────────────────────────────────────
//
//  Linux tracks every connection crossing the network stack (that's how NAT and
//  Docker port publishing work). `conntrack -E` streams those events live, so we
//  see SSH, game servers, VPNs… not just HTTP through Traefik.
//
//  Requirements: the container must share the host network namespace
//  (network_mode: host) and have the NET_ADMIN capability.
//
//  Behind port-forwarding (even double NAT), the original source address is
//  preserved, so the public client IP is visible here.
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { networkInterfaces } from 'os';
import { config } from '../config.js';
import { isPrivateIP, normalizeIp } from '../ip.js';
import type { ParsedLine, Proto } from '../types.js';

const WELL_KNOWN_PORTS: Record<number, string> = {
  21: 'ftp', 22: 'ssh', 25: 'smtp', 53: 'dns', 80: 'http', 110: 'pop3',
  123: 'ntp', 143: 'imap', 443: 'https', 465: 'smtps', 500: 'ipsec',
  587: 'submission', 853: 'dns-over-tls', 993: 'imaps', 995: 'pop3s',
  1194: 'openvpn', 1883: 'mqtt', 3306: 'mysql', 3389: 'rdp', 3478: 'stun',
  4500: 'ipsec', 5060: 'sip', 5432: 'postgres', 6379: 'redis',
  8080: 'http-alt', 8443: 'https-alt', 8883: 'mqtts', 9987: 'teamspeak',
  21027: 'syncthing', 22000: 'syncthing', 25565: 'minecraft',
  27015: 'steam', 32400: 'plex', 41641: 'tailscale', 51820: 'wireguard',
  64738: 'mumble',
};

function serviceName(proto: Proto, port: number): string {
  return config.conntrackPortNames[port] ?? WELL_KNOWN_PORTS[port] ?? `${proto}/${port}`;
}

// ── Local addresses (outbound connections start from these) ──
let localAddrs = new Set<string>();
function refreshLocalAddrs(): void {
  const next = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) next.add(normalizeIp(a.address));
  }
  localAddrs = next;
}

// ── Event parsing ─────────────────────────────
// Example lines (default output format):
//   [NEW] udp      17 30 src=203.0.113.9 dst=192.168.1.10 sport=40112 dport=51820 [UNREPLIED] src=…
//   [UPDATE] tcp   6 432000 ESTABLISHED src=203.0.113.9 dst=192.168.1.10 sport=51234 dport=22 src=… [ASSURED]
const EVENT_RE =
  /^\s*\[(NEW|UPDATE)\]\s+(tcp|udp)\s+\d+\s+\d+\s+(?:([A-Z_]+)\s+)?src=(\S+)\s+dst=(\S+)\s+sport=(\d+)\s+dport=(\d+)/;

export interface ConntrackEvent {
  kind:  'NEW' | 'UPDATE';
  proto: 'tcp' | 'udp';
  state: string;
  src:   string;
  dst:   string;
  sport: number;
  dport: number;
}

export function parseConntrackLine(line: string): ConntrackEvent | null {
  const m = EVENT_RE.exec(line);
  if (!m) return null;
  return {
    kind:  m[1] as 'NEW' | 'UPDATE',
    proto: m[2] as 'tcp' | 'udp',
    state: m[3] ?? '',
    src:   m[4]!,
    dst:   m[5]!,
    sport: parseInt(m[6]!, 10),
    dport: parseInt(m[7]!, 10),
  };
}

// ── Dedupe ────────────────────────────────────
// A single SSH session or game client can open many flows; only show one arc
// per (ip, proto, port) per dedupe window.
const lastSeen = new Map<string, number>();
function isDuplicate(key: string, now: number): boolean {
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < config.conntrackDedupeMs) return true;
  lastSeen.set(key, now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastSeen) if (now - t > config.conntrackDedupeMs) lastSeen.delete(k);
}, 60_000).unref();

/**
 * Decide whether an event is a new inbound connection worth showing.
 * TCP: only once the handshake completes (ESTABLISHED) — filters port scans
 *      hitting closed ports. UDP has no handshake, so NEW is used.
 */
export function toParsedLine(ev: ConntrackEvent, now = Date.now()): ParsedLine | null {
  if (ev.proto === 'tcp' && !(ev.kind === 'UPDATE' && ev.state === 'ESTABLISHED')) return null;
  if (ev.proto === 'udp' && ev.kind !== 'NEW') return null;

  const src = normalizeIp(ev.src);
  if (isPrivateIP(src) || localAddrs.has(src)) return null; // outbound or LAN

  if (config.conntrackIgnorePorts.has(ev.dport)) return null;
  if (config.conntrackOnlyPorts.size && !config.conntrackOnlyPorts.has(ev.dport)) return null;

  if (isDuplicate(`${src}|${ev.proto}|${ev.dport}`, now)) return null;

  return {
    ip:     src,
    router: serviceName(ev.proto, ev.dport),
    status: 0,
    method: '',
    path:   '',
    proto:  ev.proto,
    port:   ev.dport,
  };
}

// ── Process management ────────────────────────
let child: ChildProcess | null = null;
let stopping = false;

export function stopConntrack(): void {
  stopping = true;
  child?.kill();
}

function conntrackAvailable(): string | null {
  const r = spawnSync('conntrack', ['-L', '-p', 'tcp', '--dport', '1'], { encoding: 'utf8', timeout: 5_000 });
  if (r.error) return (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'conntrack binary not installed' : r.error.message;
  if (r.status !== 0) return (r.stderr || `exit code ${r.status}`).trim();
  return null;
}

/**
 * Start streaming conntrack events. Returns false (and logs why) when conntrack
 * can't be used, so the caller can fall back.
 */
export function startConntrack(onLine: (p: ParsedLine) => void): boolean {
  if (config.conntrack === 'false') return false;

  const problem = conntrackAvailable();
  if (problem) {
    const level = config.conntrack === 'true' ? console.error : console.log;
    level(`ℹ️  Conntrack disabled: ${problem}`);
    level('   To see all TCP/UDP connections, run the container with network_mode: host and cap_add: [NET_ADMIN]');
    level('   using rootful Docker (rootless Docker/Podman cannot read the host connection table).');
    return false;
  }

  refreshLocalAddrs();
  setInterval(refreshLocalAddrs, 60_000).unref();

  const run = (): void => {
    if (stopping) return;
    child = spawn('conntrack', ['-E', '-e', 'NEW,UPDATE'], { stdio: ['ignore', 'pipe', 'pipe'] });
    createInterface({ input: child.stdout! }).on('line', line => {
      const ev = parseConntrackLine(line);
      if (!ev) return;
      const parsed = toParsedLine(ev);
      if (parsed) onLine(parsed);
    });
    createInterface({ input: child.stderr! }).on('line', l => {
      // ENOBUFS warnings just mean we dropped some events under heavy load
      if (!/ENOBUFS/.test(l)) console.warn('[conntrack]', l);
    });
    child.on('exit', code => {
      if (stopping) return;
      console.warn(`[conntrack] exited (${code}), restarting in 5s`);
      setTimeout(run, 5_000).unref();
    });
  };
  run();

  console.log('🔌 Watching all inbound TCP/UDP connections (conntrack)');
  return true;
}
