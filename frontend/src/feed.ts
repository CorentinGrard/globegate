// ─────────────────────────────────────────────
//  Feed — live / replayed connection cards
// ─────────────────────────────────────────────
//  Built with DOM calls only: every field comes from logs or the network.
//  Cards are buttons: clicking one opens the visitor's details.
import { el, flag, fmtTime, requestDetails } from './util.js';
import type { Ban, Connection } from './types.js';

const MAX_FEED_ITEMS = 6;

const feedList  = document.getElementById('feed-list')!;
const feedTitle = document.querySelector<HTMLElement>('.feed-title')!;

export function setFeedTitle(text: string): void { feedTitle.textContent = text; }
export function clearFeed(): void { feedList.replaceChildren(); }

function badge(c: Connection): HTMLElement {
  if (c.proto === 'tcp' || c.proto === 'udp') {
    return el('span', `badge b-${c.proto}`, `${c.proto.toUpperCase()} :${Number(c.port) || '?'}`);
  }
  const s = Number(c.status) || 0;
  const cls = !s ? 'b-mute' : s >= 500 ? 'b-err' : s >= 400 ? 'b-warn' : s >= 300 ? 'b-redir' : 'b-ok';
  return el('span', `badge ${cls}`, s ? String(s) : '—');
}

function card(color: string, top: HTMLElement[], bottom: HTMLElement[], right: HTMLElement, onClick: () => void, extra = ''): HTMLElement {
  const bar = el('span', 'fi-bar');
  bar.style.background = color;            // CSSOM: invalid values are ignored, never executed
  bar.style.boxShadow  = `0 0 10px ${color}`;
  const t = el('div', 'fi-top'); t.append(...top);
  const b = el('div', 'fi-bot'); b.append(...bottom);
  const main = el('div', 'fi-main'); main.append(t, b);
  const btn = el('button', `fi glass ${extra}`.trim());
  btn.type = 'button';
  btn.append(bar, main, right);
  btn.addEventListener('click', onClick);

  feedList.insertBefore(btn, feedList.firstChild);
  // Hard-remove overflow immediately (no animation) to keep the list bounded
  while (feedList.children.length > MAX_FEED_ITEMS) feedList.lastElementChild?.remove();
  return btn;
}

/**
 * Add a connection to the top of the feed.
 * Returns the element so the caller can remove it when its arc fades.
 */
export function addFeedItem(c: Connection): HTMLElement {
  const loc = [c.city, c.country].filter(Boolean).join(', ') || c.ip || 'Unknown location';
  const req = c.proto === 'http' || !c.proto ? `${c.method} ${c.path}` : (c.ip || c.org || `port ${Number(c.port) || '?'}`);

  const locEl = el('span', 'fi-loc', loc);
  locEl.title = [c.ip, c.org].filter(Boolean).join(' · ');
  const top = [el('span', 'fi-flag', flag(c.countryCode)), locEl];
  if (c.blocked) {
    const sh = el('span', 'fi-blocked', '🛡');
    sh.title = 'Blocked: this IP was banned by CrowdSec';
    top.push(sh);
  }
  top.push(el('span', 'fi-t', fmtTime(Date.parse(c.timestamp), true)));

  const svc = el('span', 'fi-svc', c.router);
  svc.style.color = c.color;
  return card(c.color, top, [svc, el('span', 'fi-req', req)], badge(c),
    () => requestDetails({ conn: c.id }, c), c.blocked ? 'blocked' : '');
}

/** A CrowdSec ban in the feed. */
export function addBanFeedItem(b: Ban, label: string, color: string): HTMLElement {
  const loc = [b.city, b.country].filter(Boolean).join(', ') || b.ip || 'Unknown location';
  const top = [el('span', 'fi-flag', flag(b.countryCode)), el('span', 'fi-loc', `Banned · ${loc}`),
    el('span', 'fi-t', fmtTime(Date.parse(b.start), true))];
  const why = el('span', 'fi-svc', label);
  why.style.color = color;
  why.title = b.scenario;
  const hours = Math.max(1, Math.round((Date.parse(b.until) - Date.parse(b.start)) / 3_600_000));
  return card(color, top, [why, el('span', 'fi-req', b.ip || b.org)], el('span', 'badge b-err', `${b.type} ${hours}h`),
    () => requestDetails({ ban: b.id }, b), 'ban');
}

/** Animate a feed item out. Safe to call any time. */
export function removeFeedItem(e: HTMLElement | null): void {
  if (!e?.parentNode || e.classList.contains('leaving')) return;
  e.classList.add('leaving');
  e.addEventListener('animationend', () => e.remove(), { once: true });
}
