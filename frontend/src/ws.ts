// ─────────────────────────────────────────────
//  WebSocket — connection lifecycle + message dispatch
// ─────────────────────────────────────────────
import { spawnArc, isVisible }           from './arcs.js';
import { addFeedItem, removeFeedItem }   from './feed.js';
import { orientGlobe, placeServerMarker } from './globe.js';
import {
  recordConnection, recordRouter, applyStats,
  applyServiceColors, updateCounters, updateServices,
} from './stats.js';
import { setDbOldest, updateTlCursor, updateTlLabel, loadDensity, isHistoryMode } from './timeline.js';
import { renderSources, renderAbout } from './settings.js';
import { setStatus } from './status.js';
import type { Connection, InitPayload, WsMessage } from './types.js';

let initialised = false;

function handleInit(data: InitPayload): void {
  const { serverLocation, recentConnections, stats, serviceColors, oldest, sources } = data;

  applyServiceColors(serviceColors);
  applyStats(stats);
  setDbOldest(oldest);
  renderSources(sources ?? []);
  renderAbout(data.version, data.ipDisplay);

  document.getElementById('srv-sub')!.textContent = serverLocation.label;
  placeServerMarker(serverLocation.lat, serverLocation.lon);

  // Only re-orient on first load, not on every reconnect
  if (!initialised) {
    orientGlobe(serverLocation.lat, serverLocation.lon);
    recentConnections.slice(-8).forEach((c, i) => {
      recordConnection(c);
      if (isVisible(c)) setTimeout(() => spawnArc(c), i * 250);
    });
    updateTlCursor(1.0);
    initialised = true;
  }

  updateCounters();
  updateServices();
  updateTlLabel();
  void loadDensity();
}

function handleConnection(c: Connection): void {
  recordConnection(c);
  recordRouter(c.router);
  if (isHistoryMode()) return; // counted, but not drawn over a replay
  updateCounters();
  if (!isVisible(c)) return;
  const feedEl = addFeedItem(c);
  spawnArc(c, () => removeFeedItem(feedEl));
}

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws    = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen  = () => setStatus('live');
  ws.onclose = () => { setStatus('off'); setTimeout(connect, 3_000); };
  ws.onerror = () => ws.close();

  ws.onmessage = ({ data }) => {
    let msg: WsMessage;
    try { msg = JSON.parse(data as string) as WsMessage; } catch { return; }
    if (msg.type === 'init')       handleInit(msg.data);
    if (msg.type === 'connection') handleConnection(msg.data);
    if (msg.type === 'stats') { applyStats(msg.data); if (!isHistoryMode()) updateServices(); }
  };
}
