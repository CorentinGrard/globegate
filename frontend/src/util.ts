// ─────────────────────────────────────────────
//  Small shared helpers
// ─────────────────────────────────────────────

/** Escape text before putting it in innerHTML (log fields are attacker-controlled). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

/** ISO country code → flag emoji ("FR" → 🇫🇷). Empty string when unknown. */
export function flag(cc: string | undefined): string {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0)));
}

/** Same deterministic hash as backend/src/colors.ts */
export function serviceColor(name: string): string {
  const key = name?.toLowerCase() || 'default';
  let h = 0;
  for (const ch of key) h = ch.charCodeAt(0) + ((h << 5) - h);
  const hue = Math.abs((h * 137.508) % 360);
  return `hsl(${hue.toFixed(1)},75%,62%)`;
}

/** Element with a class and optional text. Text is never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string | number): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
}

// ── Details panel requests ────────────────────
// Feed cards, ban rows and the globe ask for details through a DOM event, so
// they don't need to import the panel.
export type DetailsTarget = { conn: string } | { ban: string };
export interface DetailsHint { ip?: string; city?: string; country?: string; countryCode?: string; org?: string }
export interface DetailsRequest { target: DetailsTarget; hint?: DetailsHint }

export function requestDetails(target: DetailsTarget, hint?: DetailsHint): void {
  document.dispatchEvent(new CustomEvent<DetailsRequest>('globegate:details', { detail: { target, hint } }));
}

// ── Time formatting ───────────────────────────
const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** "14:32", or "Tue 14:32" when not today. */
export function fmtTime(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
  return sameDay(d, new Date()) ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

/** localStorage that never throws (private mode etc.) */
export function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) as T; }
  catch { return fallback; }
}
export function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
