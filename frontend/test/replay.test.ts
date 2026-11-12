import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_PLAY_MS, LEAD_IN_MS, PERIOD_PLAY_MS, PERIODS,
  advance, agoLabel, barAt, barCount, fmtRate, fracOf, isClipped, nextChunk, periodRange, playbackRate, quietSkip, timeAt,
} from '../src/replay.ts';

const H = 3_600_000;
const r = { from: 0, to: H };

test('track position ↔ time, clamped to the period', () => {
  assert.equal(fracOf(H / 4, r), 0.25);
  assert.equal(fracOf(-5, r), 0);
  assert.equal(fracOf(2 * H, r), 1);
  assert.equal(timeAt(0.5, r), H / 2);
  assert.equal(fracOf(timeAt(0.3, r), r), 0.3);
  assert.equal(fracOf(10, { from: 10, to: 10 }), 0, 'an empty range does not divide by zero');
});

test('barAt picks the bar holding a time, the end belongs to the last bar', () => {
  assert.equal(barAt(0, r, 60), 0);
  assert.equal(barAt(H / 60 - 1, r, 60), 0);
  assert.equal(barAt(H / 60, r, 60), 1);
  assert.equal(barAt(H, r, 60), 59);
  assert.equal(barAt(H * 9, r, 60), 59);
  assert.equal(barAt(H / 2, r, 0), 0, 'no bars yet');
});

test('the whole period plays in a minute at 1×', () => {
  for (const p of PERIODS) {
    const rate = playbackRate({ from: 0, to: p.ms }, 1);
    assert.equal(rate * PERIOD_PLAY_MS, p.ms, p.key);
    assert.equal(playbackRate({ from: 0, to: p.ms }, 2), rate * 2);
  }
});

test('speed labels', () => {
  assert.equal(fmtRate(playbackRate(r, 1)), '1 min/s');
  assert.equal(fmtRate(playbackRate({ from: 0, to: 7 * 24 * H }, 1)), '2.8 h/s');
  assert.equal(fmtRate(playbackRate(r, 0.25)), '15 s/s');
  assert.equal(fmtRate(0), '1 s/s', 'never shows 0');
});

test('period labels and range', () => {
  assert.equal(agoLabel(45 * 60_000), '45m ago');
  assert.equal(agoLabel(10_000), '1m ago');
  assert.equal(agoLabel(6 * H), '6h ago');
  assert.equal(agoLabel(7 * 24 * H), '7d ago');

  const now = 100 * H;
  assert.deepEqual(periodRange(now, H, 0), { from: 99 * H, to: now });
  // History only goes back 10 minutes: start there, and say so
  const short = periodRange(now, 24 * H, now - 600_000);
  assert.deepEqual(short, { from: now - 600_000, to: now });
  assert.equal(isClipped(short, 24 * H), true);
  assert.equal(isClipped(periodRange(now, H, 0), H), false);
  // Brand new database: still at least a minute
  assert.deepEqual(periodRange(now, H, now), { from: now - 60_000, to: now });
});

test('barCount: about one bar per 12 px, within limits', () => {
  assert.equal(barCount(600), 50);
  assert.equal(barCount(100), 24);
  assert.equal(barCount(5000), 120);
});

test('nextChunk keeps a few seconds of playback loaded ahead', () => {
  const rate = playbackRate(r, 1); // 60 real ms per playback ms
  const ahead = rate * CHUNK_PLAY_MS;
  assert.deepEqual(nextChunk(0, 0, H, rate), { from: 0, to: ahead });
  assert.deepEqual(nextChunk(ahead, ahead / 2, H, rate), { from: ahead, to: 2 * ahead }, 'running low: fetch more');
  assert.equal(nextChunk(2 * ahead, 0, H, rate), null, 'enough loaded');
  assert.deepEqual(nextChunk(H - 1000, H - 2000, H, rate), { from: H - 1000, to: H }, 'never past the period');
  assert.equal(nextChunk(H, H - 10, H, rate), null, 'all loaded');
});

test('quietSkip jumps over long gaps to just before the next connection', () => {
  const rate = playbackRate(r, 1);
  const chunk = { from: 0, to: rate * CHUNK_PLAY_MS };
  const next = H / 2;
  assert.equal(quietSkip(chunk, next, H, rate), next - rate * LEAD_IN_MS);
  assert.equal(quietSkip(chunk, null, H, rate), H, 'nothing left: go to the end (then live)');
  // An empty full chunk is always worth skipping; only a short one at the very end plays through
  const tail = { from: H - rate * 1_000, to: H };
  assert.equal(quietSkip(tail, null, H, rate), null, 'short gap: just play through');
  assert.equal(quietSkip(chunk, 2 * H, H, rate), H, 'next connection after the period');
});

test('advance moves with time, waits for data and skips quiet stretches', () => {
  const rate = 60;
  // Normal playback
  assert.deepEqual(advance({ T: 0, loadedTo: 10_000, quietFrom: null }, 16, rate, false), { T: 960, loadedTo: 10_000, quietFrom: null });
  // Slow network: stops at the loaded edge
  assert.equal(advance({ T: 9_500, loadedTo: 10_000, quietFrom: null }, 16, rate, true).T, 10_000);
  // Quiet stretch ahead but connections still queued: keep playing them
  assert.equal(advance({ T: 5_000, loadedTo: 900_000, quietFrom: 4_000 }, 16, rate, false).T, 5_960);
  // Queue drained inside the quiet stretch: jump to its end
  assert.deepEqual(advance({ T: 5_000, loadedTo: 900_000, quietFrom: 4_000 }, 16, rate, true), { T: 900_000, loadedTo: 900_000, quietFrom: null });
  // Not there yet
  assert.equal(advance({ T: 1_000, loadedTo: 900_000, quietFrom: 4_000 }, 16, rate, true).T, 1_960);
});
