import { and, desc, eq, lt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type EndReason,
  type GameResult,
  type GameSummary,
  TIME_CLASSES,
  type TimeClass,
  type UserPublic,
} from '@chess/shared';
import type { Db } from './db/index.js';
import { games, ratings, users } from './db/schema.js';

export class UserRepo {
  constructor(private readonly db: Db) {}

  /** Creates the user and their three rating rows together, or not at all. Returns null if the name is taken. */
  async create(username: string, passwordHash: string): Promise<{ id: string; username: string } | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ username, usernameKey: username.toLowerCase(), passwordHash })
          .returning({ id: users.id, username: users.username });
        if (!user) throw new Error('insert returned nothing');
        await tx.insert(ratings).values(TIME_CLASSES.map((timeClass) => ({ userId: user.id, timeClass })));
        return user;
      });
    } catch (err) {
      // 23505 = unique_violation: someone already has this name.
      if ((err as { cause?: { code?: string }; code?: string }).cause?.code === '23505' || (err as { code?: string }).code === '23505') {
        return null;
      }
      throw err;
    }
  }

  async findForLogin(username: string) {
    const [user] = await this.db.select().from(users).where(eq(users.usernameKey, username.toLowerCase()));
    return user ?? null;
  }

  async findById(id: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user ?? null;
  }

  async ratingFor(userId: string, timeClass: TimeClass): Promise<number> {
    const [row] = await this.db
      .select({ rating: ratings.rating })
      .from(ratings)
      .where(and(eq(ratings.userId, userId), eq(ratings.timeClass, timeClass)));
    return Math.round(row?.rating ?? 1500);
  }

  async publicProfile(username: string): Promise<UserPublic | null> {
    const [user] = await this.db.select().from(users).where(eq(users.usernameKey, username.toLowerCase()));
    if (!user) return null;
    const rows = await this.db.select().from(ratings).where(eq(ratings.userId, user.id));
    const byClass = Object.fromEntries(
      TIME_CLASSES.map((tc) => {
        const r = rows.find((x) => x.timeClass === tc);
        return [tc, { rating: Math.round(r?.rating ?? 1500), deviation: Math.round(r?.deviation ?? 350), games: r?.gamesPlayed ?? 0 }];
      }),
    ) as UserPublic['ratings'];
    return { id: user.id, username: user.username, createdAt: user.createdAt.toISOString(), ratings: byClass };
  }

  /** Finished games for a user, newest first, 20 per page (cursor = ended-at of the last item). */
  async games(userId: string, before?: Date): Promise<GameSummary[]> {
    const white = alias(users, 'white_user');
    const black = alias(users, 'black_user');
    const filters = [or(eq(games.whiteId, userId), eq(games.blackId, userId)), eq(games.status, 'ended')];
    if (before) filters.push(lt(games.endedAt, before));
    const rows = await this.db
      .select({
        id: games.id,
        white: white.username,
        black: black.username,
        result: games.result,
        endReason: games.endReason,
        timeControl: games.timeControl,
        rated: games.rated,
        endedAt: games.endedAt,
        wb: games.whiteRatingBefore,
        wa: games.whiteRatingAfter,
        bb: games.blackRatingBefore,
        ba: games.blackRatingAfter,
      })
      .from(games)
      .innerJoin(white, eq(white.id, games.whiteId))
      .innerJoin(black, eq(black.id, games.blackId))
      .where(and(...filters))
      .orderBy(desc(games.endedAt))
      .limit(20);
    return rows.map((r) => ({
      id: r.id,
      white: r.white,
      black: r.black,
      result: r.result as GameResult,
      endReason: r.endReason as EndReason | null,
      timeControl: r.timeControl,
      rated: r.rated,
      endedAt: r.endedAt?.toISOString() ?? null,
      whiteRatingDelta: r.wa !== null && r.wb !== null ? r.wa - r.wb : null,
      blackRatingDelta: r.ba !== null && r.bb !== null ? r.ba - r.bb : null,
    }));
  }

  async finishedGame(gameId: string) {
    const [row] = await this.db
      .select({ id: games.id, status: games.status, pgn: games.pgn })
      .from(games)
      .where(eq(games.id, gameId));
    return row ?? null;
  }
}
