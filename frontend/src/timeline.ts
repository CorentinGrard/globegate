// ─────────────────────────────────────────────
//  Timeline — period picker, activity bars, replay player
// ─────────────────────────────────────────────
//  The dock covers a period (last hour … 7 days) and the side panels sum it up.
//  Live, the playhead sits at "now". Clicking the bars jumps back in time and
//  plays the past like a video: connections appear in their real order, time
//  compressed (the whole period takes about a minute at 1×), quiet stretches
//  are skipped, and playback rejoins live when it catches up. Pausing freezes
//  the arcs so they can be clicked.
import { clearAllArcs, isVisible, setArcsFrozen, spawnArc } from './arcs.js';
import { addFeedItem, clearFeed, removeFeedItem, setFeedTitle } from './feed.js';
import { addReplayBans, resetReplay, setReplayView, updateReplayBans } from './bans.js';
import { applySummary, setPeriodLabel, setReplayRate } from './stats.js';
import { setHistoryLabel } from './status.js';
import { fmtTime, load, save } from './util.js';
import type { Connection, HistoryResponse, SummaryResponse } from './types.js';

const PERIODS = [
  { key: '1h',  short: '1h',  long: 'Last hour',     ms: 3_600_000 },
  { key: '6h',  short: '6h',  long: 'Last 6 hours',  ms: 6 * 3_600_000 },
  { key: '24h', short: '24h', long: 'Last 24 hours', ms: 86_400_000 },
  { key: '7d',  short: '7d',  long: 'Last 7 days',   ms: 7 * 86_400_000 },
] as const;
const SPEEDS        = [0.25, 0.5, 1, 2, 4]; // × "the whole period in a minute"
const PERIOD_PLAY_MS = 60_000;
const ARCS_PER_SEC  = 18;     // most connections drawn per second of playback
const CHUNK_PLAY_MS = 3_000;  // data fetched ahead, in playback time
const QUIET_SKIP_MS = 1_500;  // gaps longer than this (playback time) are skipped
const LEAD_IN_MS    = 400;    // …landing this long before the next connection
const FEED_EVERY_MS = 250;    // at most 4 feed cards per second
const LIVE_ZONE     = 0.985;  // clicking beyond this fraction of the track = live

// ── State ─────────────────────────────────────
let periodIdx = Math.min(PERIODS.length - 1, Math.max(0, load('period', 2)));
let speedIdx  = Math.min(SPEEDS.length - 1, Math.max(0, load('speed', 2)));
let oldest    = Date.now();
let range     = { from: Date.now() - PERIODS[periodIdx]!.ms, to: Date.now() };
let counts: number[] = [];

let replaying = false;
let playing   = false;
let T         = 0;           // playhead (epoch ms)
let gen       = 0;           // bumped on every jump; stale fetches are dropped
let queue: { ts: number; c: Connection }[] = [];
let loadedTo  = 0;           // data fetched up to here
let quietFrom: number | null = null; // nothing happens between here and loadedTo
let loading   = false;
let lastFeed  = 0;
let lastFrame = 0;
let raf       = 0;
let dragging  = false;       // the cursor follows the mouse, not the playhead

export function isHistoryMode(): boolean { return replaying; }
export function setDbOldest(ts: number): void { oldest = ts; }

// ── DOM ───────────────────────────────────────
const wrap      = document.getElementById('tl-track-wrap')!;
const cursorEl  = document.getElementById('tl-cursor')!;
const filledEl  = document.getElementById('tl-filled')!;
const tooltip   = document.getElementById('tl-tooltip')!;
const clockEl   = document.getElementById('tl-clock')!;
const livePill  = document.getElementById('tl-live-pill')!;
const playBtn   = document.getElementById('tl-play')!;
const speedBtn  = document.getElementById('tl-speed')!;
const periodSeg = document.getElementById('tl-periods')!;
const leftLabel = document.getElementById('tl-label-left')!;
const barsEl    = document.getElementById('tl-density')!;

// ── Helpers ───────────────────────────────────
const span     = (): number => Math.max(1, range.to - range.from);
const bucketMs = (): number => span() / Math.max(1, counts.length);
/** Real milliseconds per millisecond of playback */
const rate     = (): number => span() / PERIOD_PLAY_MS * SPEEDS[speedIdx]!;
const fracOf   = (t: number): number => Math.max(0, Math.min(1, (t - range.from) / span()));
const timeAt   = (f: number): number => range.from + f * span();
const barAt    = (t: number): number => Math.max(0, Math.min(counts.length - 1, Math.floor(fracOf(t) * counts.length)));

function fracFromEvent(e: MouseEvent | TouchEvent): number {
  const rect = wrap.getBoundingClientRect();
  const x = 'touches' in e ? (e.touches[0] ?? e.changedTouches[0])!.clientX : e.clientX;
  return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
}

function fmtRate(): string {
  const perSec = rate() * 1000; // real ms per playback second
  if (perSec >= 3_600_000) return `${Math.round(perSec / 360_000) / 10} h/s`;
  if (perSec >= 60_000) return `${Math.round(perSec / 60_000)} min/s`;
  return `${Math.max(1, Math.round(perSec / 1000))} s/s`;
}

function describe(f: number): string {
  if (f >= LIVE_ZONE || !counts.length) return 'Live';
  const t = timeAt(f);
  const n = counts[barAt(t)] ?? 0;
  return `${fmtTime(t)} · ${n ? `${n.toLocaleString()} connection${n > 1 ? 's' : ''}` : 'quiet'}`;
}

// ── Rendering ─────────────────────────────────
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

let markedBar = -2;
function markBars(force = true): void {
  const cur = replaying ? barAt(T) : -1;
  if (!force && cur === markedBar) return;
  markedBar = cur;
  const bars = barsEl.children;
  const f = replaying ? fracOf(T) : 1;
  for (let i = 0; i < bars.length; i++) {
    bars[i]!.classList.toggle('past', (i + 0.5) / bars.length <= f);
    bars[i]!.classList.toggle('sel', i === cur);
  }
}

/** Move the playhead (no data changes). Skips the DOM when nothing visible changed. */
let shownKey = '';
function renderPlayhead(): void {
  if (dragging) return;
  const f = replaying ? fracOf(T) : 1;
  const key = `${replaying}|${playing}|${Math.round(f * 4000)}|${replaying ? fmtTime(T) : ''}|${counts.length}`;
  if (key === shownKey) return;
  shownKey = key;
  cursorEl.style.left = `${f * 100}%`;
  filledEl.style.width = `${f * 100}%`;
  cursorEl.classList.toggle('live', !replaying);
  livePill.classList.toggle('active', !replaying);
  playBtn.classList.toggle('playing', replaying && playing);
  playBtn.setAttribute('aria-label', replaying && playing ? 'Pause' : 'Play the period');
  playBtn.title = replaying && playing ? 'Pause (Space)' : `Play ${PERIODS[periodIdx]!.long.toLowerCase()} (Space)`;

  if (replaying) {
    const clock = fmtTime(T);
    clockEl.textContent = playing ? clock : `❚❚ ${clock}`;
    clockEl.style.left = `${f * 100}%`;
    setHistoryLabel(`${playing ? 'Replay' : 'Paused'} · ${clock}`);
    setReplayRate(counts.length ? (counts[barAt(T)] ?? 0) / (bucketMs() / 60_000) : 0);
  }
  clockEl.classList.toggle('show', replaying);
  wrap.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  wrap.setAttribute('aria-valuetext', replaying ? fmtTime(T) : 'Live');
  markBars(false);
}

function renderControls(): void {
  periodSeg.querySelectorAll<HTMLButtonElement>('button[data-period]').forEach(b => {
    const on = b.dataset['period'] === PERIODS[periodIdx]!.key;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  speedBtn.textContent = fmtRate();
  speedBtn.title = `Playback speed: ${SPEEDS[speedIdx]}× (the period plays in ${Math.round(PERIOD_PLAY_MS / SPEEDS[speedIdx]! / 1000)} s)`;
  const hours = (range.to - range.from) / 3_600_000;
  leftLabel.textContent = hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago`
    : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
  const clipped = range.to - range.from < PERIODS[periodIdx]!.ms - 60_000;
  setPeriodLabel(clipped ? `Since ${fmtTime(range.from)} (all stored history)` : PERIODS[periodIdx]!.long);
}

// ── Data for the period ───────────────────────
function barCount(): number {
  // ~1 bar per 12 px of track: readable on phones, detailed on wide screens
  return Math.max(24, Math.min(120, Math.round(wrap.getBoundingClientRect().width / 12)));
}

/**
 * Fetch the bars and the panel totals for the period ending now. Live, this
 * runs every minute; during a replay the period stays put.
 */
export async function refresh(): Promise<void> {
  if (replaying) return;
  await loadPeriod();
}

async function loadPeriod(): Promise<void> {
  const to   = Date.now();
  const from = Math.min(Math.max(to - PERIODS[periodIdx]!.ms, oldest), to - 60_000);
  const n    = barCount();
  try {
    const [d, s] = await Promise.all([
      fetch(`/api/density?from=${from}&to=${to}&buckets=${n}`).then(r => r.json()) as Promise<{ buckets: number[] }>,
      fetch(`/api/summary?from=${from}&to=${to}`).then(r => r.json()) as Promise<SummaryResponse>,
    ]);
    oldest = s.oldest;
    range  = { from, to };
    counts = d.buckets;
    applySummary(s);
    renderBars();
    renderControls();
    shownKey = '';
    renderPlayhead();
  } catch { /* non-fatal: keep what's shown */ }
}

/** A live connection: count it in the last bar right away. */
export function recordLiveBar(): void {
  if (replaying || !counts.length) return;
  counts[counts.length - 1]!++;
  scheduleBarRender();
}
let barTimer = 0;
function scheduleBarRender(): void {
  if (barTimer) return;
  barTimer = window.setTimeout(() => { barTimer = 0; renderBars(); }, 1_000);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void refresh(), 500);
});

// ── Playback ──────────────────────────────────
async function fetchWindow(from: number, to: number, limit: number): Promise<HistoryResponse> {
  const r = await fetch(`/api/history?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=${limit}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json() as HistoryResponse;
}

function showConnection(c: Connection, now: number): void {
  if (!isVisible(c)) return;
  // On busy periods only some connections get a feed card, or it would be a blur
  let feedEl: HTMLElement | null = null;
  if (now - lastFeed >= FEED_EVERY_MS) { lastFeed = now; feedEl = addFeedItem(c); }
  spawnArc(c, feedEl ? () => removeFeedItem(feedEl) : null);
}

/** Keep about CHUNK_PLAY_MS of data ahead of the playhead. */
async function fillAhead(): Promise<void> {
  if (loading || loadedTo >= range.to || loadedTo - T > rate() * CHUNK_PLAY_MS) return;
  loading = true;
  const g = gen;
  const from = loadedTo;
  const to   = Math.min(range.to, from + rate() * CHUNK_PLAY_MS);
  let data: HistoryResponse;
  try {
    data = await fetchWindow(from, to, Math.ceil(CHUNK_PLAY_MS / 1000 * ARCS_PER_SEC));
  } catch (e) {
    if (g === gen) { loading = false; setFeedTitle('Replay paused — could not load history'); pause(); }
    console.error('History fetch failed:', e);
    return;
  }
  if (g !== gen) return; // jumped elsewhere meanwhile
  loading = false;
  for (const c of data.rows) queue.push({ ts: Date.parse(c.timestamp), c });
  addReplayBans(data.bans);
  loadedTo = to;
  // Nothing in this chunk: skip ahead to just before the next connection
  if (!data.total) {
    const resume = data.next === null ? range.to : data.next - rate() * LEAD_IN_MS;
    if (resume - from > rate() * QUIET_SKIP_MS) {
      quietFrom ??= from;
      loadedTo = Math.min(range.to, Math.max(to, resume));
    }
  }
  if (playing) void fillAhead();
}

function frame(now: number): void {
  raf = 0;
  if (!replaying) return;
  const dt = Math.min(now - lastFrame, 100); // a hidden tab pauses instead of bursting
  lastFrame = now;

  if (playing) {
    // Quiet stretch and nothing left to show: jump over it
    if (quietFrom !== null && !queue.length && T >= quietFrom) {
      T = loadedTo;
      quietFrom = null;
    } else {
      T = Math.min(T + dt * rate(), loadedTo); // waits for data if the network is slow
    }
    while (queue.length && queue[0]!.ts < T) showConnection(queue.shift()!.c, now);
    if (T >= range.to) { goLive(); return; }
    void fillAhead();
  }
  updateReplayBans(T, playing);
  renderPlayhead();
  raf = requestAnimationFrame(frame);
}

function startLoop(): void {
  if (raf) return;
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

/**
 * Jump to time `t`. The few seconds before it are drawn at once so the globe
 * isn't empty, then playback continues (or stays paused).
 */
async function jump(t: number, play: boolean): Promise<void> {
  if (!counts.length) return;
  const g = ++gen;
  T = Math.max(range.from, Math.min(range.to, t));
  if (T >= timeAt(LIVE_ZONE) && play) { goLive(); return; }

  if (!replaying) {
    replaying = true;
    setReplayView(true);
  }
  playing = play;
  setArcsFrozen(!play);
  clearAllArcs();
  clearFeed();
  queue = [];
  loading = false;
  quietFrom = null;
  loadedTo = T;
  resetReplay(T);
  setFeedTitle(`Replay · ${PERIODS[periodIdx]!.long.toLowerCase()}`);
  renderPlayhead();
  startLoop();

  // Lead-in: what happened in the ~2 s (playback time) before t
  const lookback = Math.min(rate() * 2_000, T - range.from);
  try {
    const before = lookback > 0 ? await fetchWindow(T - lookback, T, 24) : null;
    if (g !== gen) return;
    if (before) {
      addReplayBans(before.bans);
      const now = performance.now();
      before.rows.filter(isVisible).forEach((c, i, all) => {
        if (i >= all.length - 4) addFeedItem(c);
        spawnArc(c);
      });
      lastFeed = now;
    }
  } catch { /* the lead-in is cosmetic */ }
  if (g !== gen) return;
  updateReplayBans(T, false);
  void fillAhead();
}

function pause(): void {
  if (!replaying || !playing) return;
  playing = false;
  setArcsFrozen(true);
  renderPlayhead();
}

function play(): void {
  if (!replaying) { void jump(range.from, true); return; } // from live: play the whole period
  if (playing) return;
  playing = true;
  setArcsFrozen(false);
  lastFrame = performance.now();
  renderPlayhead();
  void fillAhead();
}

export function goLive(): void {
  if (!replaying) return;
  gen++;
  replaying = false;
  playing = false;
  queue = [];
  setArcsFrozen(false);
  clearAllArcs();
  clearFeed();
  setReplayView(false);
  setHistoryLabel(null);
  setReplayRate(null);
  setFeedTitle('Live feed');
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  cursorEl.style.transition = 'left .3s ease';
  filledEl.style.transition = 'width .3s ease';
  setTimeout(() => { cursorEl.style.transition = ''; filledEl.style.transition = ''; }, 350);
  renderPlayhead();
  void refresh();
}

// ── Controls ──────────────────────────────────
playBtn.addEventListener('click', () => (replaying && playing ? pause() : play()));
livePill.addEventListener('click', () => goLive());

speedBtn.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  save('speed', speedIdx);
  renderControls();
  if (replaying) void fillAhead();
});

periodSeg.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-period]');
  if (!b) return;
  let i = PERIODS.findIndex(p => p.key === b.dataset['period']);
  if (i < 0) return;
  if (i === periodIdx) {
    // On phones only the current period is shown: tapping it cycles
    if (!matchMedia('(max-width: 640px)').matches) return;
    i = (i + 1) % PERIODS.length;
  }
  periodIdx = i;
  save('period', i);
  renderControls();
  if (!replaying) { void loadPeriod(); return; }
  // Keep replaying from the same moment if it's still inside the new period
  const t = T;
  const wasPlaying = playing;
  void loadPeriod().then(() => (t > range.from ? jump(t, wasPlaying) : goLive()));
});

// ── Mouse / touch on the track ────────────────
function preview(f: number): void {
  tooltip.style.left = `${f * 100}%`;
  tooltip.textContent = describe(f);
  tooltip.classList.add('show');
  cursorEl.style.left = `${f * 100}%`;
  shownKey = ''; // the next playhead render puts the cursor back
}

function startDrag(e: MouseEvent | TouchEvent): void {
  dragging = true;
  preview(fracFromEvent(e));
}
function moveDrag(e: MouseEvent | TouchEvent): void { if (dragging) preview(fracFromEvent(e)); }
function endDrag(e: MouseEvent | TouchEvent): void {
  if (!dragging) return;
  dragging = false;
  shownKey = '';
  tooltip.classList.remove('show');
  const f = fracFromEvent(e);
  if (f >= LIVE_ZONE) { goLive(); shownKey = ''; renderPlayhead(); return; }
  // From live, a click starts playing; during a replay it keeps the play state
  void jump(timeAt(f), replaying ? playing : true);
}

wrap.addEventListener('mousedown', startDrag);
window.addEventListener('mousemove', moveDrag);
window.addEventListener('mouseup', endDrag);
wrap.addEventListener('touchstart', e => { e.stopPropagation(); startDrag(e); }, { passive: true });
window.addEventListener('touchmove', moveDrag, { passive: true });
window.addEventListener('touchend', endDrag, { passive: true });

wrap.addEventListener('mousemove', e => {
  if (dragging) return;
  const f = fracFromEvent(e);
  tooltip.style.left = `${f * 100}%`;
  tooltip.textContent = describe(f);
  tooltip.classList.add('show');
});
wrap.addEventListener('mouseleave', () => { if (!dragging) tooltip.classList.remove('show'); });

// ── Keyboard ──────────────────────────────────
wrap.addEventListener('keydown', e => {
  if (!counts.length) return;
  const step = bucketMs();
  const from = replaying ? T : range.to;
  let handled = true;
  if (e.key === ' ' || e.key === 'k') (replaying && playing ? pause() : play());
  else if (e.key === 'ArrowLeft')  void jump(from - step, replaying && playing);
  else if (e.key === 'ArrowRight') { if (replaying) void jump(T + step, playing); }
  else if (e.key === 'Home')       void jump(range.from, replaying && playing);
  else if (e.key === 'End' || e.key === 'Escape') goLive();
  else handled = false;
  if (handled) e.preventDefault();
});

renderControls();
renderPlayhead();
