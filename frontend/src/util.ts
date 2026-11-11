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
