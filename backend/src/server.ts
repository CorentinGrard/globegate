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
import {
  closeDb, MAX_DENSITY_BUCKETS, pruneOldRows, queryBansInWindow, queryDensity, queryOldest, querySummary, queryWindow,
} from './db.js';
import { Hub, toPublic, toPublicBan } from './hub.js';
import { displayIp } from './public.js';
import { visitorDetails } from './visitor.js';
import type { HistoryResponse, SummaryResponse } from './types.js';
import { startTraefik } from './sources/traefik.js';
import { startConntrack, stopConntrack } from './sources/conntrack.js';
import { startCrowdSec, stopCrowdSec } from './sources/crowdsec.js';
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

  // Connections to play back (an even sample of the window)
  app.get('/api/history', (req, res) => {
    const to    = intParam(req, 'to', Date.now());
    const from  = intParam(req, 'from', to - 3_600_000);
    const limit = Math.min(intParam(req, 'limit', 200), 1_000);
    const win   = queryWindow(from, to, limit);
    const body: HistoryResponse = {
      rows: win.rows.map(toPublic), total: win.total, next: win.next,
      bans: queryBansInWindow(from, to, 200).map(toPublicBan),
    };
    res.json(body);
  });

  // Totals of a period, for the side panels
  app.get('/api/summary', (req, res) => {
    const to   = intParam(req, 'to', Date.now());
    const from = intParam(req, 'from', to - 86_400_000);
    const s    = querySummary(from, to);
    const body: SummaryResponse = {
      from, to, total: s.total, byRouter: s.byRouter, byCountry: s.byCountry, byProto: s.byProto,
      topVisitors: s.topIps.map(c => ({
        conn: c.id, ip: displayIp(c.ip), city: c.city, country: c.country, countryCode: c.countryCode, org: c.org, n: c.n,
      })),
      oldest: queryOldest(),
    };
    res.json(body);
  });

  // Details of the IP behind a connection (?conn=<id>) or a ban (?ban=<id>)
  app.get('/api/visitor', (req, res) => {
    const id = (name: string): number | undefined => {
      const v = req.query[name];
      return typeof v === 'string' && /^-?\d{1,16}$/.test(v) ? Number(v) : undefined;
    };
    const conn = id('conn');
    const ban  = id('ban');
    const details = conn !== undefined || ban !== undefined ? visitorDetails(conn !== undefined ? { conn } : { ban }) : null;
    if (!details) { res.status(404).json({ error: 'not found' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(details);
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
