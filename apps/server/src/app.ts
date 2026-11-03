import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { TokenService } from './auth/tokens.js';
import type { ChessComClient } from './chesscom.js';
import type { Config } from './config.js';
import type { GameService } from './game/service.js';
import { apiRouter } from './http/api.js';
import { authRouter } from './http/auth.js';
import { errorHandler } from './http/errors.js';
import type { Logger } from './logger.js';
import type { RateLimiter } from './security/rateLimit.js';
import type { UserRepo } from './users.js';

export function createApp(deps: {
  config: Config;
  log: Logger;
  redis: Redis;
  pool: pg.Pool;
  users: UserRepo;
  tokens: TokenService;
  games: GameService;
  chessCom: ChessComClient;
  limiter: RateLimiter;
}) {
  const { config, log, redis, pool } = deps;
  const app = express();
  app.disable('x-powered-by');
  // Behind Render/Koyeb/Caddy, trust the proxy's X-Forwarded-For so rate limits see real client IPs.
  app.set('trust proxy', config.TRUST_PROXY);

  const wsOrigin = config.APP_ORIGIN.replace(/^http/, 'ws');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'wasm-unsafe-eval' lets the browser compile Stockfish's WebAssembly; nothing else may eval.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          workerSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'", wsOrigin],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"], // no clickjacking via iframes
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    try {
      await Promise.all([redis.ping(), pool.query('SELECT 1')]);
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'health check failed');
      res.status(503).json({ ok: false });
    }
  });

  app.use(
    '/api/auth',
    authRouter({
      users: deps.users,
      tokens: deps.tokens,
      limiter: deps.limiter,
      appOrigin: config.APP_ORIGIN,
      secureCookies: config.NODE_ENV === 'production',
    }),
  );
  app.use('/api', apiRouter(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint' });
  });

  // Serving the built frontend from the same server keeps everything on one
  // origin: one free service to deploy, strict SameSite cookies, no CORS.
  if (config.WEB_DIST) {
    const dist = path.resolve(config.WEB_DIST);
    app.use(
      '/assets',
      express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '365d', index: false }),
    );
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler(log));
  return app;
}
