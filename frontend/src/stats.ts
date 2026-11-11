// ─────────────────────────────────────────────
//  Stats — counters, protocol, services and countries panels
// ─────────────────────────────────────────────
import { esc, flag, serviceColor } from './util.js';
import type { Connection, Proto } from './types.js';

let totalCount = 0;
let recentTs: number[] = [];
let countries = new Map<string, { n: number; cc: string }>();
let protoCounts: Record<Proto, number> = { http: 0, tcp: 0, udp: 0 };
let statsMap: Record<string, number> = {};
let serviceColors: Record<string, string> = {};
let inHistoryMode = false;

export function setHistoryMode(on: boolean): void { inHistoryMode = on; }

export function resetStats(): void {
  totalCount = 0; recentTs = []; countries = new Map(); statsMap = {};
  protoCounts = { http: 0, tcp: 0, udp: 0 };
}

/** Count a connection in the client-side tallies. */
export function recordConnection(c: Connection): void {
  totalCount++;
  recentTs.push(Date.now());
  if (c.country) {
    const e = countries.get(c.country) ?? { n: 0, cc: c.countryCode ?? '' };
    e.n++;
    countries.set(c.country, e);
  }
  protoCounts[c.proto ?? 'http']++;
  if (c.color) serviceColors[c.router] = c.color;
}

export function recordRouter(router: string): void {
  statsMap[router] = (statsMap[router] ?? 0) + 1;
}

export function applyStats(s: Record<string, number>): void { statsMap = { ...s }; }
export function applyServiceColors(c: Record<string, string>): void { serviceColors = { ...serviceColors, ...c }; }

// ── DOM updates ───────────────────────────────
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function setText(id: string, v: string): void {
  const el = $(id);
  if (el.textContent !== v) el.textContent = v;
}

export function updateCounters(): void {
  const now = Date.now();
  recentTs = recentTs.filter(t => now - t < 60_000);
  setText('c-total',     totalCount.toLocaleString());
  setText('c-min',       inHistoryMode ? '–' : String(recentTs.length));
  setText('c-countries', String(countries.size));
  setText('c-svc',       String(Object.keys(statsMap).length));
  setText('pn-all',      String(protoCounts.http + protoCounts.tcp + protoCounts.udp));
  setText('pn-http',     String(protoCounts.http));
  setText('pn-tcp',      String(protoCounts.tcp));
  setText('pn-udp',      String(protoCounts.udp));
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
  const rows = Object.entries(statsMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => {
    const color = serviceColors[name] ?? serviceColor(name);
    return { icon: `<i style="background:${esc(color)};box-shadow:0 0 8px ${esc(color)}"></i>`, name, n, color };
  });
  renderRank($('svc-list'), rows);
  updateCountries();
}

function updateCountries(): void {
  const rows = [...countries.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([name, e]) => ({
    icon: flag(e.cc) || '🌐', name, n: e.n, color: 'linear-gradient(90deg, rgba(124,156,255,.35), #7c9cff)',
  }));
  renderRank($('country-list'), rows);
}
