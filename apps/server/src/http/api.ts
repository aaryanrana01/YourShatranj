import { Router } from 'express';
import { archiveMonthSchema, chessComUsernameSchema, gameIdSchema, usernameSchema } from '@chess/shared';
import type { TokenService } from '../auth/tokens.js';
import type { ChessComClient } from '../chesscom.js';
import type { GameService } from '../game/service.js';
import type { RateLimiter } from '../security/rateLimit.js';
import type { UserRepo } from '../users.js';
import { type AuthedRequest, requireAuth } from './auth.js';
import { HttpError, parse } from './errors.js';

export function apiRouter(deps: {
  users: UserRepo;
  tokens: TokenService;
  games: GameService;
  chessCom: ChessComClient;
  limiter: RateLimiter;
}) {
  const { users, tokens, games, chessCom, limiter } = deps;
  const router = Router();
  const auth = requireAuth(tokens);

  router.get('/me', auth, async (req: AuthedRequest, res) => {
    const profile = await users.publicProfile(req.user!.username);
    if (!profile) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    res.json(profile);
  });

  /** Lets a refreshed or reopened page find and rejoin the game in progress. */
  router.get('/me/active-game', auth, async (req: AuthedRequest, res) => {
    res.json({ gameId: await games.activeGameOf(req.user!.id) });
  });

  router.get('/users/:username', async (req, res) => {
    const username = parse(usernameSchema, req.params.username);
    const profile = await users.publicProfile(username);
    if (!profile) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    res.json(profile);
  });

  router.get('/users/:username/games', async (req, res) => {
    const username = parse(usernameSchema, req.params.username);
    const profile = await users.publicProfile(username);
    if (!profile) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    const beforeRaw = typeof req.query.before === 'string' ? req.query.before : undefined;
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new HttpError(400, 'VALIDATION', 'Bad cursor');
    res.json(await users.games(profile.id, before));
  });

  /**
   * A finished game's PGN for review. Games still being played return 409:
   * no engine help on live games from this site.
   */
  router.get('/games/:id/pgn', async (req, res) => {
    const id = parse(gameIdSchema, req.params.id);
    const row = await users.finishedGame(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Game not found');
    if (row.status === 'active' || !row.pgn) {
      throw new HttpError(409, 'GAME_IN_PROGRESS', 'Analysis opens when the game is over');
    }
    res.json({ id: row.id, pgn: row.pgn });
  });

  // chess.com import: rate-limited per IP because each call may hit chess.com.
  const importLimit = limiter.middleware('import', 30, 60);

  router.get('/import/chesscom/:username/archives', importLimit, async (req, res) => {
    const username = parse(chessComUsernameSchema, req.params.username);
    res.json(await chessCom.archives(username));
  });

  router.get('/import/chesscom/:username/:year/:month', importLimit, async (req, res) => {
    const username = parse(chessComUsernameSchema, req.params.username);
    const { year, month } = parse(archiveMonthSchema, req.params);
    res.json(await chessCom.monthGames(username, year, month));
  });

  return router;
}
