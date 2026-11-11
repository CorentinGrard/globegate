// ─────────────────────────────────────────────
//  Side panels — totals of the selected period
// ─────────────────────────────────────────────
//  The panels always describe the period picked on the timeline (last hour,
//  24 h…), live or during a replay. The server sends exact totals; live
//  connections are added on top until the next refresh.
import { el, flag, load, requestDetails, save, serviceColor } from './util.js';
import type { Connection, Proto, SummaryResponse, TopVisitor } from './types.js';

interface Tally {
  total:     number;
  countries: Map<string, { n: number; cc: string }>;
  proto:     Record<Proto, number>;
  routers:   Record<string, number>;
  visitors:  TopVisitor[];
}

let tally: Tally = { total: 0, countries: new Map(), proto: { http: 0, tcp: 0, udp: 0 }, routers: {}, visitors: [] };
let recentTs: number[] = [];
let replayRate: number | null = null;  // connections per minute at the replay playhead
let serviceColors: Record<string, string> = {};

export function applyServiceColors(c: Record<string, string>): void { serviceColors = { ...serviceColors, ...c }; }

/** Exact totals for the period, from the server. */
export function applySummary(s: SummaryResponse): void {
  tally = {
    total:     s.total,
    countries: new Map(s.byCountry.map(c => [c.country, { n: c.n, cc: c.cc }])),
    proto:     { http: s.byProto['http'] ?? 0, tcp: s.byProto['tcp'] ?? 0, udp: s.byProto['udp'] ?? 0 },
    routers:   { ...s.byRouter },
    visitors:  s.topVisitors,
  };
  updateCounters();
  updateLists();
}

/** Add a live connection on top of the last summary. */
export function recordLive(c: Connection): void {
  recentTs.push(Date.now());
  tally.total++;
  if (c.country) {
    const e = tally.countries.get(c.country) ?? { n: 0, cc: c.countryCode ?? '' };
    e.n++;
    tally.countries.set(c.country, e);
  }
  tally.proto[c.proto ?? 'http']++;
  tally.routers[c.router] = (tally.routers[c.router] ?? 0) + 1;
  if (c.color) serviceColors[c.router] = c.color;
}

/** During a replay, "per minute" is the rate at the playhead. null = live. */
export function setReplayRate(perMin: number | null): void {
  if (replayRate === perMin) return;
  replayRate = perMin;
  updateCounters();
}

export function setPeriodLabel(text: string): void { setText('stats-cap', text); }

// ── DOM ───────────────────────────────────────
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function setText(id: string, v: string): void {
  const e = $(id);
  if (e.textContent !== v) e.textContent = v;
}

export function updateCounters(): void {
  const now = Date.now();
  recentTs = recentTs.filter(t => now - t < 60_000);
  setText('c-total',     tally.total.toLocaleString());
  setText('c-min',       String(replayRate === null ? recentTs.length : Math.round(replayRate * 10) / 10));
  setText('c-countries', String(tally.countries.size));
  setText('c-svc',       String(Object.keys(tally.routers).length));
  setText('pn-all',      String(tally.proto.http + tally.proto.tcp + tally.proto.udp));
  setText('pn-http',     String(tally.proto.http));
  setText('pn-tcp',      String(tally.proto.tcp));
  setText('pn-udp',      String(tally.proto.udp));
}

// ── "Top" card: services / countries / visitors ──
type Tab = 'services' | 'countries' | 'visitors';
let tab: Tab = load<Tab>('topTab', 'services');
const tabs = $('top-tabs');
const list = $('top-list');

tabs.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (!b) return;
  tab = b.dataset['tab'] as Tab;
  save('topTab', tab);
  updateLists();
});

interface Row { icon: HTMLElement | string; name: string; sub?: string; n: number; color: string; onClick?: () => void }

function rankRow(r: Row, max: number): HTMLElement {
  const row = el(r.onClick ? 'button' : 'div', 'rank-row');
  if (r.onClick) { (row as HTMLButtonElement).type = 'button'; row.addEventListener('click', r.onClick); }
  const ic = el('span', 'rank-ic');
  if (typeof r.icon === 'string') ic.textContent = r.icon; else ic.append(r.icon);
  const name = el('span', 'rank-name', r.name);
  if (r.sub) name.append(el('small', '', ` ${r.sub}`));
  name.title = r.sub ? `${r.name} — ${r.sub}` : r.name;
  const bar = el('div', 'rank-bar');
  const fill = el('div');
  fill.style.width = `${Math.max(3, Math.round(r.n / max * 100))}%`;
  fill.style.background = r.color;
  bar.append(fill);
  row.append(ic, name, el('span', 'rank-n', r.n.toLocaleString()), bar);
  return row;
}

function dot(color: string): HTMLElement {
  const i = el('i');
  i.style.background = color;
  i.style.boxShadow = `0 0 8px ${color}`;
  return i;
}

const COUNTRY_BAR = 'linear-gradient(90deg, rgba(124,156,255,.35), #7c9cff)';
const VISITOR_BAR = 'linear-gradient(90deg, rgba(52,211,153,.3), #34d399)';

export function updateLists(): void {
  tabs.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach(b => {
    b.classList.toggle('on', b.dataset['tab'] === tab);
    b.setAttribute('aria-selected', String(b.dataset['tab'] === tab));
  });

  let rows: Row[];
  if (tab === 'services') {
    rows = Object.entries(tally.routers).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => {
      const color = serviceColors[name] ?? serviceColor(name);
      return { icon: dot(color), name, n, color };
    });
  } else if (tab === 'countries') {
    rows = [...tally.countries.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)
      .map(([name, e]) => ({ icon: flag(e.cc) || '🌐', name, n: e.n, color: COUNTRY_BAR }));
  } else {
    rows = tally.visitors.slice(0, 5).map(v => ({
      icon: flag(v.countryCode) || '🌐',
      name: v.ip || v.org || v.city || 'Unknown',
      sub:  v.ip ? (v.org || v.city) : v.city,
      n:    v.n,
      color: VISITOR_BAR,
      onClick: () => requestDetails({ conn: v.conn }, v),
    }));
  }
  if (!rows.length) { list.replaceChildren(el('span', 'empty', 'No traffic in this period')); return; }
  const max = rows[0]!.n || 1;
  list.replaceChildren(...rows.map(r => rankRow(r, max)));
}
