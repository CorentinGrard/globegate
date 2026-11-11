// ─────────────────────────────────────────────
//  Stats — counters, protocol, services and countries panels
// ─────────────────────────────────────────────
import { esc, flag, serviceColor } from './util.js';
import type { Connection, HistoryResponse, Proto } from './types.js';

interface Tally {
  total:     number;
  countries: Map<string, { n: number; cc: string }>;
  proto:     Record<Proto, number>;
  routers:   Record<string, number>;
}

const emptyTally = (): Tally => ({ total: 0, countries: new Map(), proto: { http: 0, tcp: 0, udp: 0 }, routers: {} });

// Live figures keep accumulating while a replay is on screen, so returning to
// live shows them intact. `history` holds the totals of the replayed window.
const live: Tally = emptyTally();
let history: Tally | null = null;
let recentTs: number[] = [];
let serviceColors: Record<string, string> = {};

const view = (): Tally => history ?? live;

/** Count a live connection. */
export function recordConnection(c: Connection): void {
  live.total++;
  recentTs.push(Date.now());
  if (c.country) {
    const e = live.countries.get(c.country) ?? { n: 0, cc: c.countryCode ?? '' };
    e.n++;
    live.countries.set(c.country, e);
  }
  live.proto[c.proto ?? 'http']++;
  if (c.color) serviceColors[c.router] = c.color;
}

export function recordRouter(router: string): void {
  live.routers[router] = (live.routers[router] ?? 0) + 1;
}

/** Server-side per-service counters (since the server started). */
export function applyStats(s: Record<string, number>): void { live.routers = { ...s }; }
export function applyServiceColors(c: Record<string, string>): void { serviceColors = { ...serviceColors, ...c }; }

/** Show the exact totals of a replayed window instead of the live figures. */
export function showHistoryTotals(w: HistoryResponse): void {
  history = {
    total:     w.total,
    countries: new Map(w.byCountry.map(c => [c.country, { n: c.n, cc: c.cc }])),
    proto:     { http: w.byProto['http'] ?? 0, tcp: w.byProto['tcp'] ?? 0, udp: w.byProto['udp'] ?? 0 },
    routers:   { ...w.byRouter },
  };
  for (const r of w.rows) if (r.color) serviceColors[r.router] = r.color;
}

export function showLiveTotals(): void { history = null; }

// ── DOM updates ───────────────────────────────
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function setText(id: string, v: string): void {
  const el = $(id);
  if (el.textContent !== v) el.textContent = v;
}

export function updateCounters(): void {
  const now = Date.now();
  recentTs = recentTs.filter(t => now - t < 60_000);
  const v = view();
  setText('c-total',     v.total.toLocaleString());
  setText('c-min',       history ? '–' : String(recentTs.length));
  setText('c-countries', String(v.countries.size));
  setText('c-svc',       String(Object.keys(v.routers).length));
  setText('pn-all',      String(v.proto.http + v.proto.tcp + v.proto.udp));
  setText('pn-http',     String(v.proto.http));
  setText('pn-tcp',      String(v.proto.tcp));
  setText('pn-udp',      String(v.proto.udp));
}

function renderRank(el: HTMLElement, rows: { icon: string; name: string; n: number; color: string }[]): void {
  if (!rows.length) { el.innerHTML = '<span class="empty">Waiting for traffic…</span>'; return; }
  const max = rows[0]!.n || 1;
  el.innerHTML = rows.map(r => `
    <div class="rank-row">
      <span class="rank-ic">${r.icon}</span>
      <span class="rank-name">${esc(r.name)}</span>
      <span class="rank-n">${r.n.toLocaleString()}</span>
      <div class="rank-bar"><div style="width:${Math.max(3, Math.round(r.n / max * 100))}%;background:${esc(r.color)}"></div></div>
    </div>`).join('');
}

export function updateServices(): void {
  const rows = Object.entries(view().routers).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => {
    const color = serviceColors[name] ?? serviceColor(name);
    return { icon: `<i style="background:${esc(color)};box-shadow:0 0 8px ${esc(color)}"></i>`, name, n, color };
  });
  renderRank($('svc-list'), rows);
  updateCountries();
}

function updateCountries(): void {
  const rows = [...view().countries.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([name, e]) => ({
    icon: flag(e.cc) || '🌐', name, n: e.n, color: 'linear-gradient(90deg, rgba(124,156,255,.35), #7c9cff)',
  }));
  renderRank($('country-list'), rows);
}
