// ─────────────────────────────────────────────
//  Replay math — pure functions behind the timeline
// ─────────────────────────────────────────────
//  No DOM here, so it can be unit-tested (frontend/test). timeline.ts owns the
//  state and the rendering and asks these functions what to do.

export const PERIODS = [
  { key: '1h',  short: '1h',  long: 'Last hour',     ms: 3_600_000 },
  { key: '6h',  short: '6h',  long: 'Last 6 hours',  ms: 6 * 3_600_000 },
  { key: '24h', short: '24h', long: 'Last 24 hours', ms: 86_400_000 },
  { key: '7d',  short: '7d',  long: 'Last 7 days',   ms: 7 * 86_400_000 },
] as const;
export const SPEEDS        = [0.25, 0.5, 1, 2, 4]; // × "the whole period in a minute"
export const PERIOD_PLAY_MS = 60_000;
export const ARCS_PER_SEC  = 18;     // most connections drawn per second of playback
export const CHUNK_PLAY_MS = 3_000;  // data fetched ahead, in playback time
export const QUIET_SKIP_MS = 1_500;  // gaps longer than this (playback time) are skipped
export const LEAD_IN_MS    = 400;    // …landing this long before the next connection
export const LIVE_ZONE     = 0.985;  // clicking beyond this fraction of the track = live

export interface Range { from: number; to: number }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export const spanOf = (r: Range): number => Math.max(1, r.to - r.from);
/** Where `t` sits on the track, 0…1. */
export const fracOf = (t: number, r: Range): number => clamp((t - r.from) / spanOf(r), 0, 1);
/** The time at fraction `f` of the track. */
export const timeAt = (f: number, r: Range): number => r.from + f * spanOf(r);
/** Index of the bar that holds `t`, for `n` bars. */
export const barAt = (t: number, r: Range, n: number): number => clamp(Math.floor(fracOf(t, r) * n), 0, Math.max(0, n - 1));

/** Real milliseconds per millisecond of playback: the period plays in a minute at 1×. */
export const playbackRate = (r: Range, speed: number): number => spanOf(r) / PERIOD_PLAY_MS * speed;

/** "12 s/s", "6 min/s", "2.8 h/s": how much real time one second of playback covers. */
export function fmtRate(rate: number): string {
  const perSec = rate * 1000;
  if (perSec >= 3_600_000) return `${Math.round(perSec / 360_000) / 10} h/s`;
  if (perSec >= 60_000) return `${Math.round(perSec / 60_000)} min/s`;
  return `${Math.max(1, Math.round(perSec / 1000))} s/s`;
}

/** Label at the start of the track: "45m ago", "6h ago", "7d ago". */
export function agoLabel(spanMs: number): string {
  const hours = spanMs / 3_600_000;
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago`
    : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * The period ending `now`, never starting before the oldest stored connection
 * (no point showing empty days) and always at least a minute long.
 */
export function periodRange(now: number, periodMs: number, oldest: number): Range {
  return { from: Math.min(Math.max(now - periodMs, oldest), now - 60_000), to: now };
}

/** Whether the range had to be shortened because history doesn't go back that far. */
export const isClipped = (r: Range, periodMs: number): boolean => r.to - r.from < periodMs - 60_000;

/** About one bar per 12 px of track: readable on phones, detailed on wide screens. */
export const barCount = (trackWidth: number): number => clamp(Math.round(trackWidth / 12), 24, 120);

/**
 * The next window of history to fetch so about CHUNK_PLAY_MS of playback is
 * loaded ahead of the playhead, or null when there's enough (or nothing left).
 */
export function nextChunk(loadedTo: number, T: number, rangeTo: number, rate: number): Range | null {
  if (loadedTo >= rangeTo || loadedTo - T > rate * CHUNK_PLAY_MS) return null;
  return { from: loadedTo, to: Math.min(rangeTo, loadedTo + rate * CHUNK_PLAY_MS) };
}

/**
 * After an empty chunk [from, to): how far data can be considered loaded.
 * A long quiet stretch is skipped up to just before the next connection
 * (`next`, null when there are none left) so playback doesn't sit idle.
 * Returns null when the gap is short enough to just play through.
 */
export function quietSkip(chunk: Range, next: number | null, rangeTo: number, rate: number): number | null {
  const resume = next === null ? rangeTo : next - rate * LEAD_IN_MS;
  if (resume - chunk.from <= rate * QUIET_SKIP_MS) return null;
  return Math.min(rangeTo, Math.max(chunk.to, resume));
}

export interface Playhead {
  T: number;               // playhead (epoch ms)
  loadedTo: number;        // data fetched up to here
  quietFrom: number | null; // nothing happens between here and loadedTo
}

/**
 * Move the playhead by `dt` ms of playback. It jumps over a quiet stretch once
 * every queued connection has been shown, and never runs past loaded data
 * (on a slow network it waits instead).
 */
export function advance(p: Playhead, dt: number, rate: number, queueEmpty: boolean): Playhead {
  if (p.quietFrom !== null && queueEmpty && p.T >= p.quietFrom) return { ...p, T: p.loadedTo, quietFrom: null };
  return { ...p, T: Math.min(p.T + dt * rate, p.loadedTo) };
}
