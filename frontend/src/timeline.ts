// ─────────────────────────────────────────────
//  Timeline — scrubber bar + history playback
// ─────────────────────────────────────────────
import { spawnArc, clearAllArcs, isVisible } from './arcs.js';
import { addFeedItem, removeFeedItem, clearFeed, setFeedTitle } from './feed.js';
import {
  resetStats, recordConnection, recordRouter,
  setHistoryMode, updateCounters, updateServices,
} from './stats.js';
import { setHistoryLabel } from './status.js';
import type { Connection } from './types.js';

// ── State ─────────────────────────────────────
const TL_WINDOW  = 7 * 24 * 3_600_000;
const TL_BUCKETS = 80;
const PLAYBACK_MS = 4_000; // replay 5-min window over this duration

export let dbOldest = Date.now() - TL_WINDOW;
export function setDbOldest(ts: number): void { dbOldest = ts; }

let tlCursorFrac  = 1.0;
let tlDragging    = false;
let tlDebounce    = 0;
let historyLoading = false;
let historyMode    = false;

export function isHistoryMode(): boolean { return historyMode; }

// ── DOM refs ──────────────────────────────────
const tlTrackWrap = document.getElementById('tl-track-wrap')!;
const tlCursor    = document.getElementById('tl-cursor')!;
const tlFilled    = document.getElementById('tl-filled')!;
const tlTooltip   = document.getElementById('tl-tooltip')!;
const tlLivePill  = document.getElementById('tl-live-pill')!;
const tlLabelLeft = document.getElementById('tl-label-left')!;
const tlDensityEl = document.getElementById('tl-density')!;

// ── Helpers ───────────────────────────────────
function tlFracToTs(frac: number): number {
  return dbOldest + frac * (Date.now() - dbOldest);
}

function tlFracFromEvent(e: MouseEvent | TouchEvent): number {
  const rect  = tlTrackWrap.getBoundingClientRect();
  const clientX = 'touches' in e ? e.touches[0]!.clientX : e.clientX;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function formatTlTs(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function updateTlLabel(): void {
  const span  = Date.now() - dbOldest;
  const hours = span / 3_600_000;
  tlLabelLeft.textContent = hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago`
    : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function updateTlCursor(frac: number, animate = false): void {
  tlCursorFrac = Math.max(0, Math.min(1, frac));
  const pct    = tlCursorFrac * 100;
  if (animate) {
    tlCursor.style.transition = 'left 0.3s ease';
    setTimeout(() => { tlCursor.style.transition = ''; }, 350);
  }
  tlCursor.style.left  = `${pct}%`;
  tlFilled.style.width = `${pct}%`;
  const isLive = tlCursorFrac >= 0.995;
  tlCursor.classList.toggle('live', isLive);
  tlLivePill.classList.toggle('active', isLive);
  markPastBars();
}

function markPastBars(): void {
  const bars = tlDensityEl.children;
  for (let i = 0; i < bars.length; i++) {
    bars[i]!.classList.toggle('past', (i + 0.5) / bars.length <= tlCursorFrac);
  }
}

// ── Density sparkline ─────────────────────────
export async function loadDensity(): Promise<void> {
  try {
    const r    = await fetch(`/api/density?from=${dbOldest}&to=${Date.now()}&buckets=${TL_BUCKETS}`);
    const data = await r.json() as { buckets: number[] };
    renderDensity(data.buckets);
  } catch { /* non-fatal */ }
}

function renderDensity(buckets: number[]): void {
  if (!buckets.length) return;
  const max = Math.max(...buckets, 1);
  tlDensityEl.innerHTML = buckets
    .map(v => `<div class="tl-bar" style="height:${Math.max(Math.round(v / max * 100), 2)}%"></div>`)
    .join('');
  markPastBars();
}

// ── History playback ──────────────────────────
export function returnToLive(): void {
  historyLoading = false;
  historyMode    = false;
  setHistoryMode(false);
  setHistoryLabel(null);
  setFeedTitle('Live feed');
  clearAllArcs();
  resetStats();
  clearFeed();
  updateCounters();
  updateServices();
}

async function loadHistory(fromMs: number, toMs: number): Promise<void> {
  // Cancel any in-flight playback
  historyLoading = false;
  await Promise.resolve(); // yield so pending setTimeouts can observe the flag

  historyLoading = true;
  historyMode    = true;
  setHistoryMode(true);
  setHistoryLabel(`History · ${formatTlTs((fromMs + toMs) / 2)}`);
  setFeedTitle(`Replay ${formatTlTs(fromMs)} → ${formatTlTs(toMs)}`);

  clearAllArcs();
  resetStats();
  clearFeed();

  let rows: Connection[];
  try {
    const r  = await fetch(`/api/history?from=${fromMs}&to=${toMs}&limit=120`);
    const js = await r.json() as { rows: Connection[] };
    rows = js.rows ?? [];
  } catch (e) {
    console.error('History fetch error:', e);
    historyLoading = false;
    return;
  }

  if (!historyLoading) return; // aborted while fetching

  // Sort oldest-first for chronological playback
  rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  rows.forEach(c => { recordConnection(c); recordRouter(c.router); });
  const filtered = rows.filter(isVisible);
  if (!filtered.length) { historyLoading = false; updateCounters(); updateServices(); return; }

  // Spread animations proportionally across PLAYBACK_MS
  const t0   = new Date(filtered[0]!.timestamp).getTime();
  const span = Math.max(new Date(filtered.at(-1)!.timestamp).getTime() - t0, 1);

  filtered.forEach(c => {
    const delay = Math.round((new Date(c.timestamp).getTime() - t0) / span * PLAYBACK_MS);
    setTimeout(() => {
      if (!historyLoading) return;
      const feedEl = addFeedItem(c);
      spawnArc(c, () => removeFeedItem(feedEl));
      updateCounters();
    }, delay);
  });

  setTimeout(() => {
    if (!historyLoading) return;
    updateServices();
    historyLoading = false;
  }, PLAYBACK_MS + 100);
}

async function applyTimeline(): Promise<void> {
  if (tlCursorFrac >= 0.995) {
    returnToLive();
    return;
  }
  const centre = tlFracToTs(tlCursorFrac);
  const half   = 2.5 * 60_000; // ±2.5 min = 5-min window
  await loadHistory(centre - half, centre + half);
}

// ── Event listeners ───────────────────────────
tlTrackWrap.addEventListener('mousedown', e => {
  tlDragging = true;
  tlTooltip.classList.add('show');
  updateTlCursor(tlFracFromEvent(e));
});

window.addEventListener('mousemove', e => {
  if (!tlDragging) return;
  updateTlCursor(tlFracFromEvent(e));
  clearTimeout(tlDebounce);
  tlDebounce = window.setTimeout(() => void applyTimeline(), 300);
});

window.addEventListener('mouseup', () => {
  if (!tlDragging) return;
  tlDragging = false;
  tlTooltip.classList.remove('show');
  clearTimeout(tlDebounce);
  void applyTimeline();
});

tlTrackWrap.addEventListener('mousemove', e => {
  if (tlDragging) return;
  const frac = tlFracFromEvent(e);
  tlTooltip.style.left  = `${frac * 100}%`;
  tlTooltip.textContent = frac >= 0.995 ? 'Live' : formatTlTs(tlFracToTs(frac));
  tlTooltip.classList.add('show');
});

tlTrackWrap.addEventListener('mouseleave', () => {
  if (!tlDragging) tlTooltip.classList.remove('show');
});

tlTrackWrap.addEventListener('touchstart', e => {
  e.stopPropagation();
  tlDragging = true;
  tlTooltip.classList.add('show');
  updateTlCursor(tlFracFromEvent(e));
}, { passive: true });

window.addEventListener('touchmove', e => {
  if (!tlDragging) return;
  updateTlCursor(tlFracFromEvent(e));
  clearTimeout(tlDebounce);
  tlDebounce = window.setTimeout(() => void applyTimeline(), 400);
}, { passive: true });

window.addEventListener('touchend', () => {
  if (!tlDragging) return;
  tlDragging = false;
  tlTooltip.classList.remove('show');
  clearTimeout(tlDebounce);
  void applyTimeline();
}, { passive: true });

tlLivePill.addEventListener('click', () => {
  updateTlCursor(1.0, true);
  void applyTimeline();
});
