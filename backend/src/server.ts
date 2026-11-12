// ─────────────────────────────────────────────
//  Entry point — HTTP + WebSocket server, source wiring
// ─────────────────────────────────────────────
import { createServer } from 'http';

import { config } from './config.js';
import { initGeoIP } from './geo.js';
import { closeDb, pruneOldRows, reclaimSpace } from './db.js';
import { Hub } from './hub.js';
import { createApp, createWebSocketServer } from './app.js';
import { startTraefik } from './sources/traefik.js';
import { startConntrack, stopConntrack } from './sources/conntrack.js';
import { startCrowdSec, stopCrowdSec } from './sources/crowdsec.js';
import { startDemo } from './sources/demo.js';

async function main(): Promise<void> {
  console.log(`🌐 GlobeGate ${config.version}`);

  // ── Retention ──
  const prune = (): void => {
    const n = pruneOldRows();
    if (n > 0) console.log(`🗑  Pruned ${n} records older than ${config.retentionMs / 86_400_000} days`);
    reclaimSpace();
  };
  prune();
  setInterval(prune, 3_600_000).unref();

  await initGeoIP();

  // ── HTTP ──
  const app = createApp();

  const server = createServer(app);
  const wss    = createWebSocketServer(server, config.allowedOrigins);
  const hub    = new Hub(wss);

  // ── Sources ──
  let stopDemo: (() => void) | null = null;
  const onRealSourceLate = (): void => {
    hub.addSource('traefik');
    if (stopDemo) { stopDemo(); stopDemo = null; hub.removeSource('demo'); }
  };

  if (startTraefik(line => hub.ingest(line), onRealSourceLate)) hub.addSource('traefik');
  if (startConntrack(line => hub.ingest(line))) hub.addSource('conntrack');
  const crowdsec = startCrowdSec({
    sync:   rows => hub.syncBans(rows),
    added:  row => hub.addBan(row),
    lifted: id => hub.liftBan(id),
    online: up => (up ? hub.addSource('crowdsec') : hub.removeSource('crowdsec')),
  });

  if (config.demo === 'true' || (config.demo === 'auto' && hub.sources.length === 0)) {
    // Fake bans only when CrowdSec isn't configured, so they never mix with real ones
    stopDemo = startDemo((line, geo, asn) => hub.ingest(line, geo, asn), crowdsec ? undefined : row => hub.addBan(row));
    hub.addSource('demo');
  }

  server.listen(config.port, config.listenAddress, () => {
    console.log(`🚀 Listening on ${config.listenAddress ?? '*'}:${config.port} — sources: ${hub.sources.join(', ') || 'none'} — IPs: ${config.ipDisplay}`);
  });

  // ── Graceful shutdown (docker stop) ──
  const shutdown = (signal: string): void => {
    console.log(`👋 ${signal} received, shutting down`);
    stopConntrack();
    stopCrowdSec();
    for (const c of wss.clients) c.terminate();
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => { console.error(err); process.exit(1); });
