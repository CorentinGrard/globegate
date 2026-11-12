// ─────────────────────────────────────────────
//  Arcs — animated connection lines on the globe
// ─────────────────────────────────────────────
import * as THREE from 'three';
import { Line2 }        from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { globeGroup, GLOBE_R, ll2v, makeGlow, onResize, getServerPos, SERVER_COLOR, toScreen } from './globe.js';
import type { Connection, LatLon, Proto } from './types.js';

import { load, save } from './util.js';

// ── Arc hold duration ─────────────────────────
export let arcHoldSeconds = Number(load('arcHold', 3.5)) || 3.5;
export function setArcHold(s: number): void { arcHoldSeconds = s; save('arcHold', s); }

// ── IP filter ─────────────────────────────────
export const filteredIPs = new Set<string>(load<string[]>('filteredIPs', []));
export function saveFilteredIPs(): void { save('filteredIPs', [...filteredIPs]); }

function ipv4ToNum(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function isFiltered(rawIp: string): boolean {
  if (!rawIp) return false;
  // Masked IPv4 ("203.0.113.x") still matches ranges of /24 or wider
  const ip = rawIp.replace(/\.x$/, '.0');
  for (const f of filteredIPs) {
    if (f === rawIp || f === ip) return true;
    if (!f.includes('/')) continue;
    const [net, bits] = f.split('/') as [string, string];
    const nb = parseInt(bits, 10);
    const a = ipv4ToNum(ip), b = ipv4ToNum(net);
    if (a === null || b === null || isNaN(nb) || nb < 0 || nb > 32) continue;
    const mask = nb === 0 ? 0 : (~0 << (32 - nb)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

// ── Protocol filter ───────────────────────────
export type ProtoFilter = 'all' | Proto;
export let protoFilter: ProtoFilter = load<ProtoFilter>('protoFilter', 'all');
export function setProtoFilter(p: ProtoFilter): void { protoFilter = p; save('protoFilter', p); }

/** Should this connection be drawn / listed? */
export function isVisible(c: Connection): boolean {
  if (isFiltered(c.ip)) return false;
  return protoFilter === 'all' || (c.proto ?? 'http') === protoFilter;
}

// ── Shared line resolution (fat lines need the viewport size) ──
const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
onResize(() => {
  resolution.set(window.innerWidth, window.innerHeight);
  for (const a of arcs) a.mat.resolution.copy(resolution);
});

// ── Ripples (expanding rings at source / server) ──
interface Ripple { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; size: number; }
let ripples: Ripple[] = [];
const rippleGeo = new THREE.RingGeometry(0.82, 1, 48);

export function spawnRipple(pos: THREE.Vector3, color: THREE.Color, size = 0.06, life = 1.2): void {
  const mat  = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(rippleGeo, mat);
  mesh.position.copy(pos);
  mesh.lookAt(pos.clone().multiplyScalar(2));
  mesh.scale.setScalar(0.001);
  globeGroup.add(mesh);
  ripples.push({ mesh, mat, age: 0, life, size });
}

function tickRipples(dt: number): void {
  ripples = ripples.filter(r => {
    r.age += dt;
    const t = r.age / r.life;
    if (t >= 1) { globeGroup.remove(r.mesh); r.mat.dispose(); return false; }
    const e = 1 - Math.pow(1 - t, 3); // ease-out
    r.mesh.scale.setScalar(Math.max(0.001, e * r.size));
    r.mat.opacity = 0.9 * (1 - t);
    return true;
  });
}

// Server heartbeat
let beat = 0;
function tickServerBeat(dt: number): void {
  beat += dt;
  const pos = getServerPos();
  if (beat > 2.2 && pos) { beat = 0; spawnRipple(pos, SERVER_COLOR, 0.075, 2.0); }
}

// ── Arc state machine ─────────────────────────
type ArcState = 'drawing' | 'holding' | 'fading';

interface Arc {
  line:     Line2;
  geo:      LineGeometry;
  mat:      LineMaterial;
  curve:    THREE.QuadraticBezierCurve3;
  head:     THREE.Sprite;
  src:      THREE.Sprite;
  color:    THREE.Color;
  segments: number;
  progress: number;
  hold:     number;
  fade:     number;
  state:    ArcState;
  onFade:   (() => void) | null;
  conn:     Connection | null;  // for picking; null for decorative arcs
}

const MAX_ARCS = 160;

// While a replay is paused, drawn arcs stay on screen (so they can be clicked)
let frozen = false;
export function setArcsFrozen(f: boolean): void { frozen = f; }
const SEGMENTS = 64;
let arcs: Arc[] = [];

const baseWidth = (): number => (window.innerWidth < 641 ? 1.6 : 2);

function parseColor(css: string): THREE.Color {
  const m = css.match(/hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/);
  if (m) return new THREE.Color().setHSL(+m[1]! / 360, +m[2]! / 100, +m[3]! / 100);
  try { return new THREE.Color(css); } catch { return new THREE.Color(0x7c9cff); }
}

/** Spawn an animated arc. Returns the arc handle (or null if hidden). */
export type { Arc };

export function spawnArc(conn: Connection, onFade: (() => void) | null = null): Arc | null {
  if (!isVisible(conn)) return null;
  return spawnArcBetween(conn.source, conn.target, conn.color, onFade, conn);
}

/** Arc between any two points (also used for CrowdSec bans). */
export function spawnArcBetween(
  from: LatLon, to: LatLon, css: string,
  onFade: (() => void) | null = null, conn: Connection | null = null, rippleSize = 0.035,
): Arc {
  if (arcs.length >= MAX_ARCS) { const old = arcs.shift(); if (old) disposeArc(old); }

  const s   = ll2v(from.lat, from.lon, GLOBE_R + 0.003);
  const d   = ll2v(to.lat, to.lon, GLOBE_R + 0.003);
  const dist = s.distanceTo(d);
  const mid = s.clone().add(d).multiplyScalar(0.5).normalize().multiplyScalar(GLOBE_R + dist * 0.34 + 0.04);
  const curve = new THREE.QuadraticBezierCurve3(s, mid, d);

  const pts    = curve.getPoints(SEGMENTS);
  const color  = parseColor(css);
  const pos: number[] = [];
  const cols: number[] = [];
  pts.forEach((p, i) => {
    pos.push(p.x, p.y, p.z);
    const k = 0.25 + 0.75 * (i / SEGMENTS); // dim tail → bright towards the server
    cols.push(color.r * k, color.g * k, color.b * k);
  });

  const geo = new LineGeometry();
  geo.setPositions(pos);
  geo.setColors(cols);
  geo.instanceCount = 0;

  const mat = new LineMaterial({
    linewidth: baseWidth(),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mat.resolution.copy(resolution);

  const line = new Line2(geo, mat);
  line.computeLineDistances();
  globeGroup.add(line);

  const head = makeGlow(color.clone().lerp(new THREE.Color(0xffffff), 0.35), 0.07, 0);
  head.position.copy(s);
  globeGroup.add(head);

  const src = makeGlow(color, 0.05, 0);
  src.position.copy(s);
  globeGroup.add(src);

  spawnRipple(s, color, rippleSize, 1.0);

  const arc: Arc = {
    line, geo, mat, curve, head, src, color,
    segments: SEGMENTS, progress: 0, hold: 0, fade: 0, state: 'drawing', onFade, conn,
  };
  arcs.push(arc);
  return arc;
}

// ── Picking (click / hover on the globe) ──────
const PICK_STEPS = 32;     // the arc is tested as this many straight screen segments
const PICK_END   = 0.92;   // all arcs meet at the server: its end isn't a useful target
const _a = new THREE.Vector3();

/** Distance from point p to segment ab, in pixels. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface ArcHit { conn: Connection; d: number; arc: Arc }

/**
 * The connection whose arc passes closest to a screen point, within `maxPx`.
 * Measured against the drawn line itself (not a few sample points), skipping
 * parts hidden behind the globe. Close calls go to the newest arc.
 */
export function pickArc(x: number, y: number, maxPx = 14): ArcHit | null {
  let best: ArcHit | null = null;
  for (let i = arcs.length - 1; i >= 0; i--) {   // newest first
    const a = arcs[i]!;
    if (!a.conn || a.mat.opacity < 0.3) continue;
    const drawn = Math.min(PICK_END, a.state === 'drawing' ? 1 - Math.pow(1 - a.progress, 2) : 1);
    // The source dot is a slightly bigger target
    const src = toScreen(a.curve.getPoint(0, _a));
    let d = src ? Math.hypot(src.x - x, src.y - y) - 4 : Infinity;
    let prev = src;
    const steps = Math.max(1, Math.ceil(PICK_STEPS * drawn));
    for (let k = 1; k <= steps; k++) {
      const sp = toScreen(a.curve.getPoint(drawn * k / steps, _a));
      if (sp && prev) d = Math.min(d, segDist(x, y, prev.x, prev.y, sp.x, sp.y));
      prev = sp;
    }
    if (d <= maxPx && (!best || d < best.d - 1.5)) best = { conn: a.conn, d, arc: a };
  }
  return best;
}

// The arc under the mouse is highlighted and doesn't fade away before the click
let hovered: Arc | null = null;
export function setHoveredArc(a: Arc | null): void {
  if (a === hovered) return;
  if (hovered) hovered.mat.linewidth = baseWidth();
  hovered = a && arcs.includes(a) ? a : null;
  if (!hovered) return;
  hovered.mat.linewidth = baseWidth() * 1.9;
  if (hovered.state === 'fading') {   // caught while fading: bring it back
    hovered.state = 'holding';
    hovered.fade = 0;
    hovered.hold = arcHoldSeconds;    // and let it go as soon as the mouse leaves
    hovered.mat.opacity = 1;
    hovered.src.material.opacity = 0.9;
  }
}

/** Advance all arcs, ripples and the server beacon by dt seconds. */
export function tickArcs(dt: number): void {
  tickRipples(dt);
  tickServerBeat(dt);

  arcs = arcs.filter(a => {
    if (a.state === 'drawing') {
      a.progress = Math.min(1, a.progress + dt * 0.9);
      const e = 1 - Math.pow(1 - a.progress, 2); // ease-out travel
      a.geo.instanceCount = Math.max(1, Math.floor(e * a.segments));
      a.mat.opacity = Math.min(1, a.progress * 4);
      a.head.position.copy(a.curve.getPoint(e));
      a.head.material.opacity = Math.min(1, a.progress * 5);
      a.src.material.opacity  = Math.min(0.9, a.progress * 4);
      if (a.progress >= 1) {
        a.state = 'holding';
        a.head.material.opacity = 0;
        spawnRipple(a.curve.v2, a.color, 0.06, 1.1);
      }
    } else if (a.state === 'holding') {
      if (!frozen && a !== hovered) a.hold += dt;
      if (a.hold > arcHoldSeconds) { a.state = 'fading'; a.onFade?.(); }
    } else {
      a.fade = Math.min(1, a.fade + dt * 0.8);
      a.mat.opacity = 1 - a.fade;
      a.src.material.opacity = 0.9 * (1 - a.fade);
      if (a.fade >= 1) { disposeArc(a); return false; }
    }
    return true;
  });
}

function disposeArc(a: Arc): void {
  if (a === hovered) hovered = null;
  globeGroup.remove(a.line, a.head, a.src);
  a.geo.dispose();
  a.mat.dispose();
  a.head.material.dispose();
  a.src.material.dispose();
}

/** Immediately remove all arcs (e.g. when switching history windows or filters). */
export function clearAllArcs(): void {
  for (const a of arcs) disposeArc(a);
  arcs = [];
}
