// ─────────────────────────────────────────────
//  WebSocket — connection lifecycle + message dispatch
// ─────────────────────────────────────────────
import { spawnArc, isVisible }            from './arcs.js';
import { addFeedItem, removeFeedItem }    from './feed.js';
import { orientGlobe, placeServerMarker } from './globe.js';
import { applyServiceColors, recordLive, updateCounters, updateLists } from './stats.js';
import { setDbOldest, refresh, isHistoryMode, recordLiveBar } from './timeline.js';
import { enableBans, onBan, onUnban, setBans, setBanTarget } from './bans.js';
import { renderSources, renderAbout } from './settings.js';
import { setStatus } from './status.js';
import type { Connection, InitPayload, WsMessage } from './types.js';

let initialised = false;

// The Top list is rebuilt at most once per second on busy servers
let listsTimer = 0;
function scheduleLists(): void {
  if (listsTimer) return;
  listsTimer = window.setTimeout(() => { listsTimer = 0; updateLists(); }, 1_000);
}

function handleInit(data: InitPayload): void {
  const { serverLocation, recentConnections, serviceColors, oldest, sources } = data;

  applyServiceColors(serviceColors);
  setDbOldest(oldest);
  renderSources(sources ?? []);
  renderAbout(data.version, data.ipDisplay);
  setBanTarget(serverLocation);
  enableBans((sources ?? []).includes('crowdsec'));
  setBans(data.bans ?? []);

  document.getElementById('srv-sub')!.textContent = serverLocation.label;
  placeServerMarker(serverLocation.lat, serverLocation.lon);

  // Only re-orient on first load, not on every reconnect
  if (!initialised) {
    orientGlobe(serverLocation.lat, serverLocation.lon);
    recentConnections.slice(-8).forEach((c, i) => {
      if (isVisible(c)) setTimeout(() => { if (!isHistoryMode()) spawnArc(c); }, i * 250);
    });
    initialised = true;
  }

  // Panel totals and bars come from the server for the selected period
  void refresh();
}

function handleConnection(c: Connection): void {
  if (isHistoryMode()) return; // the replay owns the screen; totals refresh on return
  recordLive(c);
  recordLiveBar();
  updateCounters();
  scheduleLists();
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
    if (msg.type === 'ban')        onBan(msg.data, !isHistoryMode());
    if (msg.type === 'unban')      onUnban(msg.data.id);
  };
}
