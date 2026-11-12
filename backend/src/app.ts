// ─────────────────────────────────────────────
//  HTTP routes (static UI, JSON API) and the WebSocket endpoint
// ─────────────────────────────────────────────
import express, { type Express, type Request } from 'express';
import type { IncomingMessage, Server } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { config } from './config.js';
import {
  MAX_DENSITY_BUCKETS, queryBansInWindow, queryDensity, queryOldest, querySummary, queryWindow,
} from './db.js';
import { toPublic, toPublicBan, displayIp } from './public.js';
import { visitorDetails } from './visitor.js';
import { CONTENT_SECURITY_POLICY, isAllowedOrigin } from './security.js';
import type { HistoryResponse, SummaryResponse } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '../../frontend/dist');

function intParam(req: Request, name: string, fallback: number): number {
  const n = Number(req.query[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createApp(staticDir = STATIC_DIR): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(express.static(staticDir, { maxAge: '1h', setHeaders: (res, path) => {
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

  return app;
}

/** The live feed at /ws. Connections opened by other websites are refused. */
export function createWebSocketServer(server: Server, allowedOrigins: readonly string[] = []): WebSocketServer {
  return new WebSocketServer({
    server, path: '/ws', maxPayload: 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      if (isAllowedOrigin(req.headers, allowedOrigins)) return true;
      console.warn(`🚫 WebSocket refused: origin ${String(req.headers.origin).slice(0, 100)} doesn't match host ${String(req.headers.host).slice(0, 100)} (add it to ALLOWED_ORIGINS if it's your dashboard)`);
      return false;
    },
  });
}
