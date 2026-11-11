// ─────────────────────────────────────────────
//  Entry point — HTTP + WebSocket server, source wiring
// ─────────────────────────────────────────────
import express, { type Request } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { config } from './config.js';
import { initGeoIP } from './geo.js';
import { closeDb, MAX_DENSITY_BUCKETS, pruneOldRows, queryDensity, queryOldest, queryWindow } from './db.js';
import { Hub, toPublic } from './hub.js';
import { startTraefik } from './sources/traefik.js';
import { startConntrack, stopConntrack } from './sources/conntrack.js';
import { startDemo } from './sources/demo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '../../frontend/dist');

function intParam(req: Request, name: string, fallback: number): number {
  const n = Number(req.query[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function main(): Promise<void> {
  console.log(`🌐 GlobeGate ${config.version}`);

  // ── Retention ──
  const prune = (): void => {
    const n = pruneOldRows();
    if (n > 0) console.log(`🗑  Pruned ${n} records older than ${config.retentionMs / 86_400_000} days`);
  };
  prune();
  setInterval(prune, 3_600_000).unref();

  await initGeoIP();

  // ── HTTP ──
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(express.static(STATIC_DIR, { maxAge: '1h', setHeaders: (res, path) => {
    // Vite output under /assets is content-hashed and can be cached forever
    if (path.includes(`${join('dist', 'assets')}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } }));

  app.get('/health', (_req, res) => res.json({ ok: true, version: config.version }));

  app.get('/api/history', (req, res) => {
    const to    = intParam(req, 'to', Date.now());
    const from  = intParam(req, 'from', to - 3_600_000);
    const limit = Math.min(intParam(req, 'limit', 200), 1_000);
    const win   = queryWindow(from, to, limit);
    res.json({ ...win, rows: win.rows.map(toPublic), oldest: queryOldest() });
  });

  app.get('/api/density', (req, res) => {
    const to      = intParam(req, 'to', Date.now());
    const from    = intParam(req, 'from', to - config.retentionMs);
    const buckets = Math.min(intParam(req, 'buckets', 80), MAX_DENSITY_BUCKETS);
    res.json({ buckets: queryDensity(from, to, buckets) });
  });

  const server = createServer(app);
  const wss    = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
  const hub    = new Hub(wss);

  // ── Sources ──
  let stopDemo: (() => void) | null = null;
  const onRealSourceLate = (): void => {
    hub.addSource('traefik');
    if (stopDemo) { stopDemo(); stopDemo = null; hub.removeSource('demo'); }
  };

  if (startTraefik(line => hub.ingest(line), onRealSourceLate)) hub.addSource('traefik');
  if (startConntrack(line => hub.ingest(line))) hub.addSource('conntrack');

  if (config.demo === 'true' || (config.demo === 'auto' && hub.sources.length === 0)) {
    stopDemo = startDemo((line, geo) => hub.ingest(line, geo));
    hub.addSource('demo');
  }

  server.listen(config.port, config.listenAddress, () => {
    console.log(`🚀 Listening on ${config.listenAddress ?? '*'}:${config.port} — sources: ${hub.sources.join(', ') || 'none'} — IPs: ${config.ipDisplay}`);
  });

  // ── Graceful shutdown (docker stop) ──
  const shutdown = (signal: string): void => {
    console.log(`👋 ${signal} received, shutting down`);
    stopConntrack();
    for (const c of wss.clients) c.terminate();
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => { console.error(err); process.exit(1); });
