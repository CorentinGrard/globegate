// ─────────────────────────────────────────────
//  CrowdSec bans — red markers, strike animation, sidebar card
// ─────────────────────────────────────────────
//  Live: every active ban is a pulsing red dot where the attacker is. A new
//  ban "strikes" the server with a red arc. During a replay the dots show the
//  bans active at the replay time, and playback strikes when a ban starts.
import * as THREE from 'three';
import { globeGroup, GLOBE_R, ll2v, makeGlow, toScreen, getServerPos } from './globe.js';
import { spawnArcBetween, spawnRipple, isFiltered } from './arcs.js';
import { el, flag, fmtTime, requestDetails } from './util.js';
import { addBanFeedItem } from './feed.js';
import type { Ban, LatLon } from './types.js';

export const BAN_COLOR = '#f87171';
const BAN_THREE = new THREE.Color(BAN_COLOR);
const MAX_MARKERS = 500;

// ── Labels ────────────────────────────────────
const SCENARIO_LABELS: Record<string, string> = {
  'ssh-bf': 'SSH brute force', 'ssh-slow-bf': 'SSH brute force', 'ssh-time-based-bf': 'SSH brute force',
  'ssh-refused-conn': 'SSH scan', 'ssh-cve-2024-6387': 'SSH exploit',
  'http-probing': 'HTTP probing', 'http-sensitive-files': 'Sensitive files', 'http-bad-user-agent': 'Bad user agent',
  'http-cve-probing': 'CVE probing', 'http-path-traversal-probing': 'Path traversal', 'http-sqli-probing': 'SQL injection',
  'http-xss-probing': 'XSS probing', 'http-admin-interface-probing': 'Admin probing', 'http-backdoors-attempts': 'Backdoor attempt',
  'http-wordpress-scan': 'WordPress scan', 'http-crawl-non_statics': 'Aggressive crawl', 'http-generic-bf': 'Login brute force',
  'http-open-proxy': 'Open proxy probe', 'http-technology-probing': 'Tech probing', 'http-w00tw00t': 'Scanner',
  'iptables-scan-multi_ports': 'Port scan', 'http-bf-wordpress_bf': 'WordPress brute force',
};

/** "crowdsecurity/ssh-bf" → "SSH brute force" */
export function banLabel(b: Pick<Ban, 'scenario' | 'origin'>): string {
  if (b.origin === 'cscli' || b.origin === 'console') return 'Manual ban';
  const short = b.scenario.split('/').pop() ?? b.scenario;
  if (SCENARIO_LABELS[short]) return SCENARIO_LABELS[short];
  if (short.startsWith('appsec')) return 'Web attack (WAF)';
  if (/cve|log4j|spring4shell|rce/i.test(short)) return 'Exploit attempt';
  return short || 'Ban';
}

/** Time left on a ban: "3h 12m", "45m", or "ended". */
export function timeLeft(until: string, now = Date.now()): string {
  const ms = Date.parse(until) - now;
  if (!(ms > 0)) return 'ended';
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.max(1, m)}m`;
}

// ── State ─────────────────────────────────────
const live = new Map<string, Ban>();
let serverLoc: LatLon = { lat: 0, lon: 0 };
let enabled = false;                     // CrowdSec (or demo) is feeding bans

export function setBanTarget(l: LatLon): void { serverLoc = l; }

// ── Markers ───────────────────────────────────
interface Marker { ban: Ban; glow: THREE.Sprite; pos: THREE.Vector3; phase: number }
const liveGroup   = new THREE.Group();
const replayGroup = new THREE.Group();
globeGroup.add(liveGroup, replayGroup);
const liveMarkers   = new Map<string, Marker>();
const replayMarkers = new Map<string, Marker>();

function makeMarker(b: Ban, group: THREE.Group): Marker | null {
  if (!b.source || isFiltered(b.ip)) return null;
  const pos  = ll2v(b.source.lat, b.source.lon, GLOBE_R + 0.004);
  const glow = makeGlow(BAN_THREE, 0.05, 0.85);
  glow.position.copy(pos);
  group.add(glow);
  return { ban: b, glow, pos, phase: Math.random() * Math.PI * 2 };
}

function removeMarker(m: Marker): void {
  m.glow.parent?.remove(m.glow);
  m.glow.material.dispose();
}

/** Pulse the dots. */
export function tickBans(dt: number): void {
  const pulse = (m: Marker): void => {
    m.phase += dt * 2.4;
    const k = 0.5 + 0.5 * Math.sin(m.phase);
    m.glow.scale.setScalar(0.055 + 0.035 * k);
    m.glow.material.opacity = 0.7 + 0.3 * k;
  };
  if (liveGroup.visible) liveMarkers.forEach(pulse);
  replayMarkers.forEach(pulse);
}

/** The ban dot closest to a screen point, within `maxPx`. */
export function pickBan(x: number, y: number, maxPx = 14): { ban: Ban; d: number } | null {
  let best: { ban: Ban; d: number } | null = null;
  const check = (m: Marker): void => {
    const sp = toScreen(m.pos);
    if (!sp) return;
    const d = Math.hypot(sp.x - x, sp.y - y);
    if (d <= maxPx && (!best || d < best.d)) best = { ban: m.ban, d };
  };
  if (liveGroup.visible) liveMarkers.forEach(check);
  replayMarkers.forEach(check);
  return best;
}

/** Red arc from the attacker to the server, with a shock ring on both ends. */
function strike(b: Ban): void {
  if (!b.source || isFiltered(b.ip)) return;
  spawnArcBetween(b.source, serverLoc, BAN_COLOR, null, null, 0.09);
  const srv = getServerPos();
  if (srv) setTimeout(() => spawnRipple(srv, BAN_THREE, 0.1, 1.4), 1_100);
}

// ── Live updates (WebSocket) ──────────────────
export function setBans(list: Ban[]): void {
  enabled = enabled || list.length > 0;
  live.clear();
  liveMarkers.forEach(removeMarker);
  liveMarkers.clear();
  for (const b of list) addLive(b);
  render();
}

function addLive(b: Ban): void {
  live.set(b.id, b);
  liveMarkers.get(b.id) && removeMarker(liveMarkers.get(b.id)!);
  liveMarkers.delete(b.id);
  if (liveMarkers.size >= MAX_MARKERS) return;
  const m = makeMarker(b, liveGroup);
  if (m) liveMarkers.set(b.id, m);
}

/** A ban from the server. New ones strike and appear in the feed when `animate`. */
export function onBan(b: Ban, animate: boolean): void {
  enabled = true;
  const isNew = !live.has(b.id);
  addLive(b);
  if (isNew && animate) { strike(b); addBanFeedItem(b, banLabel(b), BAN_COLOR); }
  render();
}

export function onUnban(id: string): void {
  live.delete(id);
  const m = liveMarkers.get(id);
  if (m) { removeMarker(m); liveMarkers.delete(id); }
  render();
}

export function enableBans(on: boolean): void { enabled = enabled || on; render(); }

// Bans expire on their own even if the server can't tell us (CrowdSec down)
setInterval(() => {
  const now = Date.now();
  for (const b of [...live.values()]) if (Date.parse(b.until) <= now) onUnban(b.id);
  render();
}, 30_000);

// ── Replay ────────────────────────────────────
interface ReplayBan { ban: Ban; start: number; until: number }
const replayBans = new Map<string, ReplayBan>();
let replaying = false;
let replayT = 0;

/** Enter / leave a replay: the live dots are hidden while the past is shown. */
export function setReplayView(on: boolean): void {
  replaying = on;
  liveGroup.visible = !on;
  resetReplay(0);
}

/** Forget the replayed bans (after a jump) and move the replay clock to `t`. */
export function resetReplay(t: number): void {
  replayMarkers.forEach(removeMarker);
  replayMarkers.clear();
  replayBans.clear();
  replayT = t;
  render();
}

/** Bans of a fetched replay window (active at some point in it). */
export function addReplayBans(list: Ban[]): void {
  for (const b of list) {
    if (!replayBans.has(b.id)) replayBans.set(b.id, { ban: b, start: Date.parse(b.start), until: Date.parse(b.until) });
  }
}

/**
 * Move the replay clock: a dot for every ban active at `t`. While playing,
 * bans that start between the previous time and `t` strike the server.
 */
export function updateReplayBans(t: number, playing: boolean): void {
  const prev = replayT;
  replayT = t;
  let changed = false;
  for (const { ban, start, until } of replayBans.values()) {
    const on = start <= t && t < until;
    const m = replayMarkers.get(ban.id);
    if (on && !m) {
      const nm = makeMarker(ban, replayGroup);
      if (nm) replayMarkers.set(ban.id, nm);
      if (playing && prev < start) { strike(ban); addBanFeedItem(ban, banLabel(ban), BAN_COLOR); }
      changed = true;
    } else if (!on && m) {
      removeMarker(m);
      replayMarkers.delete(ban.id);
      changed = true;
    }
  }
  if (changed) render();
}

// ── Sidebar card ──────────────────────────────
const card  = document.getElementById('card-bans')!;
const listEl = document.getElementById('ban-list')!;
const countEl = document.getElementById('bans-n')!;

function row(b: Ban): HTMLElement {
  const btn = el('button', 'ban-row');
  btn.type = 'button';
  const where = [b.city, b.countryCode].filter(Boolean).join(', ') || b.country || 'Unknown';
  const t = el('span', 'ban-t', replaying ? fmtTime(Date.parse(b.start)) : timeLeft(b.until));
  t.title = replaying ? 'Banned at' : `Ban ends ${new Date(b.until).toLocaleString()}`;
  btn.append(
    el('span', 'ban-ic', flag(b.countryCode) || '🌐'),
    el('span', 'ban-who', b.ip || where),
    t,
    el('span', 'ban-why', `${banLabel(b)} · ${b.ip ? where : b.org || '—'}`),
  );
  btn.title = b.scenario;
  btn.addEventListener('click', () => requestDetails({ ban: b.id }, b));
  return btn;
}

function render(): void {
  card.hidden = !enabled;
  if (!enabled) return;
  const shown = replaying ? [...replayMarkers.values()].map(m => m.ban) : [...live.values()];
  const list = shown.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  countEl.textContent = replaying ? `${list.length} active then` : `${list.length} active`;
  if (!list.length) {
    listEl.replaceChildren(el('span', 'empty', replaying ? 'No active bans at that time' : 'No active bans'));
    return;
  }
  listEl.replaceChildren(...list.slice(0, 4).map(row));
}
render();
