// ─────────────────────────────────────────────
//  Service color — deterministic per service name
// ─────────────────────────────────────────────

/** Produces a consistent, visually distinct color for any service name. */
export function getServiceColor(name: string): string {
  const key = name?.toLowerCase() || 'default';
  let h = 0;
  for (const ch of key) h = ch.charCodeAt(0) + ((h << 5) - h);
  // Use golden-ratio hue steps for maximum visual separation between services
  const hue = Math.abs((h * 137.508) % 360);
  const color = `hsl(${hue.toFixed(1)},75%,62%)`;
  SERVICE_COLORS[name] = color;
  return color;
}

/** The color map sent to the frontend, filled on-the-fly from seen service names. */
export const SERVICE_COLORS: Record<string, string> = {};