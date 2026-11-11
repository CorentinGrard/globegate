// ─────────────────────────────────────────────
//  Timeline — density bars + history replay
// ─────────────────────────────────────────────
//  The stored history is split into equal slices ("bars"). Clicking, dragging
//  or arrow-keying onto a bar replays exactly that slice: the panels show its
//  real totals, and an even sample of its connections is animated.
import { spawnArc, clearAllArcs, isVisible } from './arcs.js';
import { addFeedItem, removeFeedItem, clearFeed, setFeedTitle } from './feed.js';
import { showHistoryTotals, showLiveTotals, updateCounters, updateServices } from './stats.js';
import { setHistoryLabel } from './status.js';
import type { HistoryResponse } from './types.js';

const PLAYBACK_MS  = 6_000;  // a replayed slice is animated over this long
const REPLAY_ROWS  = 150;    // connections animated per replay (totals are exact)
const LIVE_ZONE    = 0.99;   // cursor beyond this fraction = live

// ── State ─────────────────────────────────────
let dbOldest = Date.now();
let range = { from: Date.now() - 3_600_000, to: Date.now() };  // what the bars cover
let counts: number[] = [];
let selected: number | null = null;   // bar being replayed, null = live
let cursorFrac = 1;
let dragging = false;
let dragTimer = 0;

// Every replay gets a new generation; timers of older generations do nothing
let generation = 0;
let timers: number[] = [];

export function isHistoryMode(): boolean { return selected !== null; }
export function setDbOldest(ts: number): void { dbOldest = ts; }

// ── DOM ───────────────────────────────────────
const wrap      = document.getElementById('tl-track-wrap')!;
const cursorEl  = document.getElementById('tl-cursor')!;
const filledEl  = document.getElementById('tl-filled')!;
const tooltip   = document.getElementById('tl-tooltip')!;
const livePill  = document.getElementById('tl-live-pill')!;
const leftLabel = document.getElementById('tl-label-left')!;
const barsEl    = document.getElementById('tl-density')!;

// ── Helpers ───────────────────────────────────
const bucketMs = (): number => (range.to - range.from) / Math.max(1, counts.length);

function bucketRange(i: number): { from: number; to: number } {
  const w = bucketMs();
  return { from: Math.round(range.from + i * w), to: Math.round(range.from + (i + 1) * w) };
}

function bucketAt(frac: number): number {
  return Math.max(0, Math.min(counts.length - 1, Math.floor(frac * counts.length)));
}

function fracFromEvent(e: MouseEvent | TouchEvent): number {
  const rect = wrap.getBoundingClientRect();
  const x = 'touches' in e ? (e.touches[0] ?? e.changedTouches[0])!.clientX : e.clientX;
  return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
}

function fmt(ms: number, withDay: boolean): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return withDay ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : time;
}

function fmtRange(from: number, to: number): string {
  const today = new Date().toDateString();
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  const day = new Date(from).toDateString() !== today;
  return sameDay ? `${fmt(from, day)}–${fmt(to, false)}` : `${fmt(from, true)} – ${fmt(to, true)}`;
}

function describe(frac: number): string {
  if (frac >= LIVE_ZONE || !counts.length) return 'Live';
  const i = bucketAt(frac);
  const r = bucketRange(i);
  const n = counts[i] ?? 0;
  return `${fmtRange(r.from, r.to)} · ${n ? `${n.toLocaleString()} connection${n > 1 ? 's' : ''}` : 'no connections'}`;
}

// ── Cursor, tooltip, labels ───────────────────
function setCursor(frac: number, animate = false): void {
  cursorFrac = Math.max(0, Math.min(1, frac));
  if (animate) {
    cursorEl.style.transition = 'left .3s ease';
    filledEl.style.transition = 'width .3s ease';
    setTimeout(() => { cursorEl.style.transition = ''; filledEl.style.transition = ''; }, 350);
  }
  cursorEl.style.left   = `${cursorFrac * 100}%`;
  filledEl.style.width  = `${cursorFrac * 100}%`;
  const live = selected === null;
  cursorEl.classList.toggle('live', live);
  livePill.classList.toggle('active', live);
  wrap.setAttribute('aria-valuenow', String(Math.round(cursorFrac * 100)));
  wrap.setAttribute('aria-valuetext', live ? 'Live' : describe(cursorFrac));
  markBars();
}

function showTooltip(frac: number): void {
  tooltip.style.left = `${frac * 100}%`;
  tooltip.textContent = describe(frac);
  tooltip.classList.add('show');
}

function markBars(): void {
  const bars = barsEl.children;
  for (let i = 0; i < bars.length; i++) {
    bars[i]!.classList.toggle('past', (i + 0.5) / bars.length <= cursorFrac);
    bars[i]!.classList.toggle('sel', i === selected);
  }
}

/** Kept for ws.ts: position the cursor without changing the mode. */
export function updateTlCursor(frac: number): void { setCursor(frac); }

export function updateTlLabel(): void {
  const hours = (Date.now() - range.from) / 3_600_000;
  leftLabel.textContent = hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago`
    : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
}

// ── Density bars ──────────────────────────────
function barCount(): number {
  // ~1 bar per 14 px of track: readable on phones, detailed on wide screens
  return Math.max(24, Math.min(120, Math.round(wrap.getBoundingClientRect().width / 14)));
}

export async function loadDensity(): Promise<void> {
  if (isHistoryMode()) return; // keep the bars stable while a slice is replayed
  const from = Math.min(dbOldest, Date.now() - 60_000);
  const to = Date.now();
  const n = barCount();
  try {
    const r = await fetch(`/api/density?from=${from}&to=${to}&buckets=${n}`);
    const data = await r.json() as { buckets: number[] };
    if (isHistoryMode()) return;
    range = { from, to };
    counts = data.buckets;
    renderBars();
    updateTlLabel();
  } catch { /* non-fatal: bars stay as they are */ }
}

function renderBars(): void {
  const max = Math.max(...counts, 1);
  barsEl.replaceChildren(...counts.map(v => {
    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    bar.style.height = `${Math.max(Math.round(v / max * 100), 3)}%`;
    if (!v) bar.classList.add('empty');
    return bar;
  }));
  markBars();
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void loadDensity(), 500);
});

// ── Replay ────────────────────────────────────
function cancelReplay(): void {
  generation++;
  timers.forEach(t => clearTimeout(t));
  timers = [];
  clearAllArcs();
  clearFeed();
}

export function returnToLive(): void {
  if (!isHistoryMode()) return;
  cancelReplay();
  selected = null;
  showLiveTotals();
  setHistoryLabel(null);
  setFeedTitle('Live feed');
  updateCounters();
  updateServices();
  setCursor(1, true);
}

async function replayBucket(i: number): Promise<void> {
  if (i === selected) return;
  cancelReplay();
  const gen = generation;
  selected = i;
  const { from, to } = bucketRange(i);
  setCursor((i + 0.5) / counts.length, true);
  setHistoryLabel(`History · ${fmtRange(from, to)}`);
  setFeedTitle(`Replay ${fmtRange(from, to)}`);

  let data: HistoryResponse;
  try {
    const r = await fetch(`/api/history?from=${from}&to=${to}&limit=${REPLAY_ROWS}`);
    data = await r.json() as HistoryResponse;
  } catch (e) {
    console.error('History fetch failed:', e);
    if (gen === generation) setFeedTitle('Replay failed — try again');
    return;
  }
  if (gen !== generation) return; // another slice was picked meanwhile

  showHistoryTotals(data);
  updateCounters();
  updateServices();

  if (!data.total) { setFeedTitle(`No connections · ${fmtRange(from, to)}`); return; }
  if (data.total > data.rows.length) {
    setFeedTitle(`Replay ${fmtRange(from, to)} · ${data.rows.length} of ${data.total.toLocaleString()}`);
  }

  const rows = data.rows.filter(isVisible);
  if (!rows.length) return;
  const t0 = Date.parse(rows[0]!.timestamp);
  const span = Math.max(Date.parse(rows.at(-1)!.timestamp) - t0, 1);
  for (const c of rows) {
    const delay = rows.length === 1 ? 0 : Math.round((Date.parse(c.timestamp) - t0) / span * PLAYBACK_MS);
    timers.push(window.setTimeout(() => {
      if (gen !== generation) return;
      const feedEl = addFeedItem(c);
      spawnArc(c, () => removeFeedItem(feedEl));
    }, delay));
  }
}

/** Act on a cursor position: replay the slice under it, or go live. */
function apply(frac: number): void {
  if (frac >= LIVE_ZONE || !counts.length) { returnToLive(); setCursor(1); return; }
  void replayBucket(bucketAt(frac));
}

// ── Mouse / touch ─────────────────────────────
function startDrag(e: MouseEvent | TouchEvent): void {
  dragging = true;
  const f = fracFromEvent(e);
  setCursor(f);
  showTooltip(f);
}

function moveDrag(e: MouseEvent | TouchEvent): void {
  if (!dragging) return;
  const f = fracFromEvent(e);
  setCursor(f);
  showTooltip(f);
  clearTimeout(dragTimer);
  dragTimer = window.setTimeout(() => apply(f), 250);
}

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  clearTimeout(dragTimer);
  tooltip.classList.remove('show');
  apply(cursorFrac);
}

wrap.addEventListener('mousedown', startDrag);
window.addEventListener('mousemove', moveDrag);
window.addEventListener('mouseup', endDrag);
wrap.addEventListener('touchstart', e => { e.stopPropagation(); startDrag(e); }, { passive: true });
window.addEventListener('touchmove', moveDrag, { passive: true });
window.addEventListener('touchend', endDrag, { passive: true });

wrap.addEventListener('mousemove', e => { if (!dragging) showTooltip(fracFromEvent(e)); });
wrap.addEventListener('mouseleave', () => { if (!dragging) tooltip.classList.remove('show'); });

livePill.addEventListener('click', () => returnToLive());

// ── Keyboard ──────────────────────────────────
wrap.addEventListener('keydown', e => {
  if (!counts.length) return;
  const last = counts.length - 1;
  let target: number | 'live' | null = null;
  if (e.key === 'ArrowLeft')  target = selected === null ? last : Math.max(0, selected - 1);
  if (e.key === 'ArrowRight') target = selected === null ? null : selected >= last ? 'live' : selected + 1;
  if (e.key === 'Home')       target = 0;
  if (e.key === 'End' || e.key === 'Escape') target = 'live';
  if (target === null) return;
  e.preventDefault();
  if (target === 'live') returnToLive();
  else void replayBucket(target);
});
