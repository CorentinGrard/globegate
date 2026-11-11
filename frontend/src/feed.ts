// ─────────────────────────────────────────────
//  Feed — live / history connection cards
// ─────────────────────────────────────────────
import { esc, flag } from './util.js';
import type { Connection } from './types.js';

const MAX_FEED_ITEMS = 6;

const feedList  = document.getElementById('feed-list')!;
const feedTitle = document.querySelector<HTMLElement>('.feed-title')!;

export function setFeedTitle(text: string): void { feedTitle.textContent = text; }
export function clearFeed(): void { feedList.innerHTML = ''; }

function badge(c: Connection): string {
  if (c.proto === 'tcp' || c.proto === 'udp') {
    return `<span class="badge b-${c.proto}">${c.proto.toUpperCase()} :${c.port}</span>`;
  }
  const s = c.status;
  const cls = !s ? 'b-mute' : s >= 500 ? 'b-err' : s >= 400 ? 'b-warn' : s >= 300 ? 'b-redir' : 'b-ok';
  return `<span class="badge ${cls}">${s || '—'}</span>`;
}

/**
 * Add a connection to the top of the feed.
 * Returns the element so the caller can remove it when its arc fades.
 */
export function addFeedItem(c: Connection): HTMLElement {
  const el  = document.createElement('div');
  el.className = 'fi glass';
  const loc = [c.city, c.country].filter(Boolean).join(', ') || c.ip || 'Unknown location';
  const t   = new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const req = c.proto === 'http' || !c.proto ? `${c.method} ${c.path}` : (c.ip || `port ${c.port}`);

  el.innerHTML = `
    <span class="fi-bar" style="background:${esc(c.color)};box-shadow:0 0 10px ${esc(c.color)}"></span>
    <div class="fi-main">
      <div class="fi-top">
        <span class="fi-flag">${flag(c.countryCode)}</span>
        <span class="fi-loc"${c.ip ? ` title="${esc(c.ip)}"` : ''}>${esc(loc)}</span>
        <span class="fi-t">${t}</span>
      </div>
      <div class="fi-bot">
        <span class="fi-svc" style="color:${esc(c.color)}">${esc(c.router)}</span>
        <span class="fi-req">${esc(req)}</span>
      </div>
    </div>
    ${badge(c)}`;

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
