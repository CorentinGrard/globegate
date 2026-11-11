// ─────────────────────────────────────────────
//  Feed — live / history connection cards
// ─────────────────────────────────────────────
import { flag } from './util.js';
import type { Connection } from './types.js';

const MAX_FEED_ITEMS = 6;

const feedList  = document.getElementById('feed-list')!;
const feedTitle = document.querySelector<HTMLElement>('.feed-title')!;

export function setFeedTitle(text: string): void { feedTitle.textContent = text; }
export function clearFeed(): void { feedList.replaceChildren(); }

/** Element with a class and optional text. Text is never parsed as HTML. */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function badge(c: Connection): HTMLElement {
  if (c.proto === 'tcp' || c.proto === 'udp') {
    return node('span', `badge b-${c.proto}`, `${c.proto.toUpperCase()} :${Number(c.port) || '?'}`);
  }
  const s = Number(c.status) || 0;
  const cls = !s ? 'b-mute' : s >= 500 ? 'b-err' : s >= 400 ? 'b-warn' : s >= 300 ? 'b-redir' : 'b-ok';
  return node('span', `badge ${cls}`, s ? String(s) : '—');
}

/**
 * Add a connection to the top of the feed.
 * Returns the element so the caller can remove it when its arc fades.
 * Built with DOM calls only: every field comes from logs or the network.
 */
export function addFeedItem(c: Connection): HTMLElement {
  const loc = [c.city, c.country].filter(Boolean).join(', ') || c.ip || 'Unknown location';
  const t   = new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const req = c.proto === 'http' || !c.proto ? `${c.method} ${c.path}` : (c.ip || `port ${Number(c.port) || '?'}`);

  const bar = node('span', 'fi-bar');
  bar.style.background = c.color;            // CSSOM: invalid values are ignored, never executed
  bar.style.boxShadow  = `0 0 10px ${c.color}`;

  const locEl = node('span', 'fi-loc', loc);
  if (c.ip) locEl.title = c.ip;
  const top = node('div', 'fi-top');
  top.append(node('span', 'fi-flag', flag(c.countryCode)), locEl, node('span', 'fi-t', t));

  const svc = node('span', 'fi-svc', c.router);
  svc.style.color = c.color;
  const bot = node('div', 'fi-bot');
  bot.append(svc, node('span', 'fi-req', req));

  const main = node('div', 'fi-main');
  main.append(top, bot);

  const el = node('div', 'fi glass');
  el.append(bar, main, badge(c));

  feedList.insertBefore(el, feedList.firstChild);

  // Hard-remove overflow immediately (no animation) to keep the list bounded
  while (feedList.children.length > MAX_FEED_ITEMS) feedList.lastElementChild?.remove();
  return el;
}

/** Animate a feed item out. Safe to call any time. */
export function removeFeedItem(el: HTMLElement | null): void {
  if (!el?.parentNode || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}
