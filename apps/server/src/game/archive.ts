import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { TimeClass } from '@chess/shared';
import type { Db } from '../db/index.js';
import { games, moves, ratings } from '../db/schema.js';
import { DEFAULT_GLICKO, rateGame } from './glicko2.js';
import { Chess } from 'chess.js';
import { tryMove } from './rules.js';
import type { StoredGame } from './types.js';

const TERMINATION: Record<string, string> = {
  checkmate: 'won by checkmate',
  resign: 'won by resignation',
  timeout: 'won on time',
  timeout_vs_insufficient: 'drawn: timeout vs insufficient material',
  stalemate: 'drawn by stalemate',
  repetition: 'drawn by repetition',
  fifty_move: 'drawn by the 50-move rule',
  insufficient_material: 'drawn: insufficient material',
  agreement: 'drawn by agreement',
  abandoned: 'won: opponent abandoned',
  aborted: 'game aborted',
};

/** Standard PGN so the game opens in any chess tool, including our own analysis board. */
/** "0:04:58.3": PGN clock comment format, read by most chess tools (and our review's time chart). */
function clk(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

export function buildPgn(game: StoredGame, siteOrigin: string): string {
  // Replay move by move so each move can carry the mover's remaining time.
  const chess = new Chess();
  for (const m of game.moves) {
    if (!tryMove(chess, m.uci)) throw new Error(`Corrupt move list: ${m.uci}`);
    chess.setComment(`[%clk ${clk(m.clockMs)}]`);
  }
  const date = new Date(game.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const winnerName = game.result === '1-0' ? game.white.username : game.result === '0-1' ? game.black.username : '';
  const termination = game.endReason ? TERMINATION[game.endReason] ?? game.endReason : 'unterminated';
  chess.setHeader('Event', `${game.rated ? 'Rated' : 'Casual'} ${game.timeClass} game`);
  chess.setHeader('Site', `${siteOrigin}/game/${game.id}`);
  chess.setHeader('Date', `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`);
  chess.setHeader('White', game.white.username);
  chess.setHeader('Black', game.black.username);
  chess.setHeader('Result', game.result);
  chess.setHeader('WhiteElo', String(game.white.rating));
  chess.setHeader('BlackElo', String(game.black.rating));
  chess.setHeader('TimeControl', game.timeControl);
  chess.setHeader('Termination', winnerName ? `${winnerName} ${termination}` : termination);
  return chess.pgn();
}

export class GameArchive {
  constructor(
    private readonly db: Db,
    private readonly siteOrigin: string,
  ) {}

  async insertNewGame(game: StoredGame): Promise<void> {
    await this.db.insert(games).values({
      id: game.id,
      whiteId: game.white.id,
      blackId: game.black.id,
      timeControl: game.timeControl,
      timeClass: game.timeClass,
      rated: game.rated,
      status: 'active',
      startedAt: new Date(game.createdAt),
    });
  }

  /**
   * Writes a finished game, its moves and both rating changes in ONE
   * transaction. The `WHERE status = 'active'` makes it run at most once: if it
   * already ran (say the server crashed right after committing), the second
   * call changes nothing and returns the rating changes saved the first time.
   */
  async finish(game: StoredGame): Promise<{ w: number; b: number } | null> {
    const pgn = buildPgn(game, this.siteOrigin);
    const status = game.status === 'aborted' ? 'aborted' : 'ended';

    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(games)
        .set({
          status,
          result: game.result,
          endReason: game.endReason,
          pgn,
          finalFen: game.fen,
          endedAt: new Date(game.endedAt ?? Date.now()),
        })
        .where(and(eq(games.id, game.id), eq(games.status, 'active')))
        .returning({ id: games.id });

      if (updated.length === 0) {
        const [row] = await tx.select().from(games).where(eq(games.id, game.id));
        if (!row || row.whiteRatingAfter === null || row.whiteRatingBefore === null) return null;
        return {
          w: row.whiteRatingAfter - row.whiteRatingBefore,
          b: (row.blackRatingAfter ?? 0) - (row.blackRatingBefore ?? 0),
        };
      }

      if (game.moves.length > 0) {
        await tx
          .insert(moves)
          .values(game.moves.map((m, ply) => ({ gameId: game.id, ply, uci: m.uci, san: m.san, clockMs: Math.round(m.clockMs) })))
          .onConflictDoNothing();
      }

      if (!game.rated || status === 'aborted' || game.result === '*') return null;

      const timeClass: TimeClass = game.timeClass;
      const ids = [game.white.id, game.black.id];
      // Make sure both rows exist, then lock them. Ordering by user id means two
      // games finishing at once always lock in the same order (no deadlock).
      await tx
        .insert(ratings)
        .values(ids.map((userId) => ({ userId, timeClass })))
        .onConflictDoNothing();
      const rows = await tx
        .select()
        .from(ratings)
        .where(and(inArray(ratings.userId, ids), eq(ratings.timeClass, timeClass)))
        .orderBy(ratings.userId)
        .for('update');

      const find = (id: string) => rows.find((r) => r.userId === id) ?? { ...DEFAULT_GLICKO, gamesPlayed: 0 };
      const w = find(game.white.id);
      const b = find(game.black.id);
      const whiteScore = game.result === '1-0' ? 1 : game.result === '0-1' ? 0 : 0.5;
      const next = rateGame(w, b, whiteScore);

      for (const [userId, before, after] of [
        [game.white.id, w, next.white],
        [game.black.id, b, next.black],
      ] as const) {
        await tx
          .update(ratings)
          .set({
            rating: after.rating,
            deviation: after.deviation,
            volatility: after.volatility,
            gamesPlayed: before.gamesPlayed + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(ratings.userId, userId), eq(ratings.timeClass, timeClass)));
      }

      const wb = Math.round(w.rating);
      const wa = Math.round(next.white.rating);
      const bb = Math.round(b.rating);
      const ba = Math.round(next.black.rating);
      await tx
        .update(games)
        .set({ whiteRatingBefore: wb, whiteRatingAfter: wa, blackRatingBefore: bb, blackRatingAfter: ba })
        .where(eq(games.id, game.id));
      return { w: wa - wb, b: ba - bb };
    });
  }

  /**
   * Startup cleanup: a game row marked active in Postgres but missing from
   * Redis can never finish (its live state is gone), so mark it aborted.
   * Only rows older than a minute, so a game being created right now on
   * another instance is left alone.
   */
  async abortOrphans(liveIds: string[]): Promise<number> {
    const cutoff = new Date(Date.now() - 60_000);
    const conditions = [eq(games.status, 'active'), lt(games.startedAt, cutoff)];
    if (liveIds.length > 0) conditions.push(notInArray(games.id, liveIds));
    const res = await this.db
      .update(games)
      .set({ status: 'aborted', endReason: 'aborted', endedAt: sql`now()` })
      .where(and(...conditions))
      .returning({ id: games.id });
    return res.length;
  }
}
