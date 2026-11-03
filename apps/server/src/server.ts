import http from 'node:http';
import { Redis } from 'ioredis';
import { createApp } from './app.js';
import { TokenService } from './auth/tokens.js';
import { ChessComClient } from './chesscom.js';
import type { Config } from './config.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { GameArchive } from './game/archive.js';
import { GameService } from './game/service.js';
import { GameStore } from './game/store.js';
import type { Logger } from './logger.js';
import { Matchmaker } from './matchmaking.js';
import { RateLimiter } from './security/rateLimit.js';
import { createIo, registerSocketHandlers, socketEvents } from './socket.js';
import { UserRepo } from './users.js';

/** Wires every part together. Tests build the same server in-process. */
export async function buildServer(config: Config, log: Logger) {
  const { db, pool } = createDb(config.DATABASE_URL);
  await runMigrations(pool);

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    // Upstash and other managed Redis close idle connections; keep ours alive.
    keepAlive: 30_000,
  });
  redis.on('error', (err) => log.error({ err }, 'redis error'));

  const users = new UserRepo(db);
  const tokens = new TokenService(db, config.JWT_ACCESS_SECRET, config.REFRESH_TOKEN_SECRET);
  const limiter = new RateLimiter(redis);
  const chessCom = new ChessComClient(redis, `YourShatranj/1.0 (contact: ${config.CHESSCOM_CONTACT})`);

  const httpServer = http.createServer();
  const io = createIo(httpServer, config, redis);
  const games = new GameService(new GameStore(redis), new GameArchive(db, config.APP_ORIGIN), socketEvents(io), log);
  const matchmaker = new Matchmaker(redis, games, log);
  const app = createApp({ config, log, redis, pool, users, tokens, games, chessCom, limiter });
  httpServer.on('request', app);
  const { sweepPresence } = registerSocketHandlers(io, { config, tokens, users, games, matchmaker, log });

  let presenceTimer: NodeJS.Timeout | null = null;

  async function start(port = config.PORT): Promise<number> {
    const { active } = await games.recover();
    matchmaker.start();
    // Players of games that survived a restart get 20 s to reconnect before being marked gone.
    presenceTimer = setTimeout(() => void sweepPresence(active), 20_000);
    presenceTimer.unref();
    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    log.info({ port: actualPort }, 'server listening');
    return actualPort;
  }

  /**
   * Graceful shutdown (deploys send SIGTERM): stop taking new work, let
   * in-flight moves finish, then close connections. Live game state is in
   * Redis, so the next instance continues every game.
   */
  async function stop(): Promise<void> {
    log.info('shutting down');
    if (presenceTimer) clearTimeout(presenceTimer);
    matchmaker.stop();
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await games.drain();
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
  }

  return { start, stop, httpServer, io, games, matchmaker, redis, pool, db };
}
