// ─────────────────────────────────────────────
//  Visitor details — click an arc, a ban dot or a feed card
// ─────────────────────────────────────────────
//  Shows everything stored about the IP behind it: network owner, when it was
//  first and last seen, what it connected to, and its CrowdSec bans.
import * as THREE from 'three';
import { pickArc, spawnRipple, filteredIPs, saveFilteredIPs, clearAllArcs } from './arcs.js';
import { BAN_COLOR, banLabel, pickBan, timeLeft } from './bans.js';
import { GLOBE_R, ll2v } from './globe.js';
import { ago, el, flag, fmtTime, serviceColor, type DetailsHint, type DetailsRequest, type DetailsTarget } from './util.js';
import type { Ban, Connection, VisitorResponse } from './types.js';

const panel   = document.getElementById('detail-panel')!;
const flagEl  = document.getElementById('dp-flag')!;
const locEl   = document.getElementById('dp-loc')!;
const ipEl    = document.getElementById('dp-ip')!;
const body    = document.getElementById('dp-body')!;
const tipEl   = document.getElementById('globe-tip')!;
const canvas  = document.getElementById('canvas-container')!;

let current = '';          // key of the target shown
let request = 0;           // bumped per open; late answers are dropped
let pulseTimer = 0;

// ── Open / close ──────────────────────────────
function keyOf(t: DetailsTarget): string { return 'conn' in t ? `c${t.conn}` : `b${t.ban}`; }

function header(h: DetailsHint): void {
  flagEl.textContent = flag(h.countryCode) || '🌐';
  locEl.textContent = [h.city, h.country].filter(Boolean).join(', ') || 'Unknown location';
  ipEl.textContent = h.ip || (h.org ?? '');
}

export async function openDetails(target: DetailsTarget, hint: DetailsHint = {}): Promise<void> {
  const key = keyOf(target);
  if (key === current && panel.classList.contains('open')) return;
  current = key;
  const req = ++request;
  header(hint);
  body.replaceChildren(el('div', 'dp-loading', 'Loading…'));
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');

  const q = 'conn' in target ? `conn=${encodeURIComponent(target.conn)}` : `ban=${encodeURIComponent(target.ban)}`;
  let v: VisitorResponse;
  try {
    const r = await fetch(`/api/visitor?${q}`);
    if (r.status === 404) throw new Error('gone');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    v = await r.json() as VisitorResponse;
  } catch (e) {
    if (req !== request) return;
    body.replaceChildren(el('div', 'dp-loading', (e as Error).message === 'gone'
      ? 'Nothing stored about this one (it may be older than the retention period).'
      : 'Could not load the details. Try again.'));
    return;
  }
  if (req !== request) return;
  header(v);
  render(v);
  highlight(v);
}

export function closeDetails(): void {
  request++;
  current = '';
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  clearInterval(pulseTimer);
}

document.addEventListener('globegate:details', e => {
  const { target, hint } = (e as CustomEvent<DetailsRequest>).detail;
  void openDetails(target, hint);
});
document.getElementById('dp-close')!.addEventListener('click', closeDetails);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) closeDetails(); });

/** Pulse a ring where the visitor is, while the panel is open. */
function highlight(v: VisitorResponse): void {
  clearInterval(pulseTimer);
  if (!v.country && !v.source.lat && !v.source.lon) return;
  const pos = ll2v(v.source.lat, v.source.lon, GLOBE_R + 0.004);
  const color = new THREE.Color(v.bans.some(isActive) ? BAN_COLOR : '#ffffff');
  const ring = (): void => spawnRipple(pos, color, 0.09, 1.6);
  ring();
  pulseTimer = window.setInterval(ring, 1_600);
}

const isActive = (b: Ban): boolean => Date.parse(b.until) > Date.now();

// ── Rendering ─────────────────────────────────
function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const s = el('section', 'dp-sec');
  s.append(el('h3', 'dp-h', title), ...children.filter((c): c is HTMLElement => c !== null));
  return s;
}

function tile(label: string, value: string, title?: string): HTMLElement {
  const t = el('div', 'dp-tile');
  t.append(el('span', 'dp-tl', label), el('span', 'dp-tv', value));
  if (title) t.title = title;
  return t;
}

function bans(v: VisitorResponse): HTMLElement | null {
  if (!v.bans.length) return null;
  const box = el('div', 'dp-bans');
  for (const b of v.bans.slice(0, 5)) {
    const active = isActive(b);
    const row = el('div', `dp-ban ${active ? 'on' : ''}`);
    row.title = `${b.scenario} (${b.origin})`;
    row.append(
      el('span', 'dp-ban-ic', '🛡'),
      el('span', 'dp-ban-what', `${banLabel(b)}${b.range ? ` · range ${b.ip}` : ''}`),
      el('span', 'dp-ban-when', active ? `${timeLeft(b.until)} left` : fmtTime(Date.parse(b.start))),
    );
    box.append(row);
  }
  return box;
}

function activity(v: VisitorResponse): HTMLElement | null {
  if (!v.activity.buckets.length || !v.total) return null;
  const wrap = el('div', 'dp-act');
  const bars = el('div', 'dp-act-bars');
  const max = Math.max(...v.activity.buckets, 1);
  const w = (v.activity.to - v.activity.from) / v.activity.buckets.length;
  v.activity.buckets.forEach((n, i) => {
    const b = el('i');
    b.style.height = `${n ? Math.max(12, Math.round(n / max * 100)) : 4}%`;
    if (!n) b.className = 'z';
    b.title = `${fmtTime(v.activity.from + i * w)} · ${n} connection${n === 1 ? '' : 's'}`;
    bars.append(b);
  });
  const days = Math.round((v.activity.to - v.activity.from) / 86_400_000);
  const labels = el('div', 'dp-act-lab');
  labels.append(el('span', '', `${days} days ago`), el('span', '', 'now'));
  wrap.append(bars, labels);
  return wrap;
}

function services(v: VisitorResponse): HTMLElement | null {
  const rows = Object.entries(v.byRouter);
  if (!rows.length) return null;
  const max = rows[0]![1] || 1;
  const list = el('div', 'rank');
  for (const [name, n] of rows.slice(0, 6)) {
    const color = v.recent.find(r => r.router === name)?.color ?? serviceColor(name);
    const row = el('div', 'rank-row');
    const ic = el('span', 'rank-ic');
    const dot = el('i');
    dot.style.background = color;
    ic.append(dot);
    const bar = el('div', 'rank-bar');
    const fill = el('div');
    fill.style.width = `${Math.max(3, Math.round(n / max * 100))}%`;
    fill.style.background = color;
    bar.append(fill);
    row.append(ic, el('span', 'rank-name', name), el('span', 'rank-n', n.toLocaleString()), bar);
    list.append(row);
  }
  return list;
}

function chips(v: VisitorResponse): HTMLElement | null {
  const items: HTMLElement[] = [];
  for (const p of v.byPort) items.push(el('span', `badge b-${p.proto}`, `${p.proto.toUpperCase()} :${p.port} × ${p.n}`));
  for (const [status, n] of Object.entries(v.byStatus).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const s = Number(status);
    const cls = !s ? 'b-mute' : s >= 500 ? 'b-err' : s >= 400 ? 'b-warn' : s >= 300 ? 'b-redir' : 'b-ok';
    items.push(el('span', `badge ${cls}`, `${s || '—'} × ${n}`));
  }
  if (!items.length) return null;
  const box = el('div', 'dp-chips');
  box.append(...items);
  return box;
}

function recent(v: VisitorResponse): HTMLElement | null {
  if (!v.recent.length) return null;
  const list = el('div', 'dp-recent');
  for (const c of v.recent) {
    const row = el('div', 'dp-r');
    const svc = el('span', 'dp-r-svc', c.router);
    svc.style.color = c.color;
    const what = c.proto === 'http' ? `${c.method} ${c.path}` : `${c.proto.toUpperCase()} :${c.port}`;
    const st = c.proto === 'http' ? String(c.status || '—') : '';
    const stEl = el('span', `dp-r-st ${c.status >= 400 ? 'bad' : ''}`, c.blocked ? `🛡${st}` : st);
    if (c.blocked) stEl.title = 'Blocked by CrowdSec';
    row.append(el('span', 'dp-r-t', fmtTime(Date.parse(c.timestamp), true)), svc, el('span', 'dp-r-what', what), stEl);
    list.append(row);
  }
  return list;
}

function actions(v: VisitorResponse): HTMLElement | null {
  if (!v.ip) return null;
  const box = el('div', 'dp-actions');
  if (navigator.clipboard && !v.ip.includes('x') && !v.ip.includes('/')) {
    const copy = el('button', 'sp-btn ghost', 'Copy IP');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(v.ip).then(() => { copy.textContent = 'Copied'; });
    });
    box.append(copy);
  }
  const hidden = filteredIPs.has(v.ip);
  const hide = el('button', 'sp-btn ghost', hidden ? 'Hidden here' : 'Hide on this browser');
  hide.type = 'button';
  hide.disabled = hidden;
  hide.title = 'Stop drawing this IP in this browser (Settings → Hidden IPs to undo)';
  hide.addEventListener('click', () => {
    filteredIPs.add(v.ip);
    saveFilteredIPs();
    clearAllArcs();
    document.dispatchEvent(new CustomEvent('globegate:filters'));
    hide.textContent = 'Hidden here';
    hide.disabled = true;
  });
  box.append(hide);
  return box;
}

function render(v: VisitorResponse): void {
  const parts: (HTMLElement | null)[] = [];
  if (v.org || v.asn) {
    const org = el('div', 'dp-org', v.org || 'Unknown network');
    if (v.asn) org.append(el('span', 'dp-asn', `AS${v.asn}`));
    parts.push(org);
  }
  parts.push(bans(v));
  if (v.total) {
    const tiles = el('div', 'dp-tiles');
    tiles.append(
      tile('Connections', v.total.toLocaleString()),
      tile('First seen', ago(v.firstSeen), new Date(v.firstSeen).toLocaleString()),
      tile('Last seen', ago(v.lastSeen), new Date(v.lastSeen).toLocaleString()),
    );
    parts.push(tiles);
  } else if (!v.bans.length) {
    parts.push(el('div', 'dp-loading', 'No connections stored for this IP.'));
  }
  const act = activity(v);
  if (act) parts.push(section('Activity', act));
  const svc = services(v);
  if (svc) parts.push(section('Services', svc, chips(v)));
  const rec = recent(v);
  if (rec) parts.push(section(`Latest ${v.recent.length === 1 ? 'connection' : `${v.recent.length} connections`}`, rec));
  parts.push(actions(v));
  body.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  body.scrollTop = 0;
}

// ── Picking on the globe ──────────────────────
type Hit = { conn: Connection; d: number } | { ban: Ban; d: number };

function pick(x: number, y: number, radius: number): Hit | null {
  const a = pickArc(x, y, radius);
  const b = pickBan(x, y, radius);
  if (a && b) return b.d <= a.d + 4 ? b : a; // dots are small: let them win close calls
  return a ?? b;
}

let down: { x: number; y: number; t: number } | null = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', e => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = performance.now() - down.t < 600;
  down = null;
  if (moved > 6 || !quick) return; // that was a drag of the globe
  const hit = pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 26 : 14);
  if (!hit) return;
  if ('conn' in hit) void openDetails({ conn: hit.conn.id }, hit.conn);
  else void openDetails({ ban: hit.ban.id }, hit.ban);
});

// Hover: pointer cursor + a small label
let hoverFrame = 0;
let hoverAt = { x: 0, y: 0 };
canvas.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  hoverAt = { x: e.clientX, y: e.clientY };
  if (e.buttons) { hideTip(); return; }
  if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
});
canvas.addEventListener('pointerleave', hideTip);

function hideTip(): void {
  tipEl.classList.remove('show');
  canvas.style.cursor = '';
}

function updateHover(): void {
  hoverFrame = 0;
  const hit = pick(hoverAt.x, hoverAt.y, 12);
  if (!hit) { hideTip(); return; }
  canvas.style.cursor = 'pointer';
  if ('conn' in hit) {
    const c = hit.conn;
    tipEl.textContent = `${flag(c.countryCode)} ${c.city || c.country || c.ip || '?'} → ${c.router}`;
  } else {
    const b = hit.ban;
    tipEl.textContent = `🛡 ${banLabel(b)} · ${b.city || b.country || b.ip || '?'}`;
  }
  tipEl.style.transform = `translate(${hoverAt.x + 14}px, ${hoverAt.y + 14}px)`;
  tipEl.classList.add('show');
}
