/**
 * Permanent data lives in Postgres. Live games live in Redis while they are
 * played; when a game ends, the game row, its moves and both rating changes
 * are written here in one transaction.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const timeClassEnum = pgEnum('time_class', ['bullet', 'blitz', 'rapid']);
export const gameStatusEnum = pgEnum('game_status', ['active', 'ended', 'aborted']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 20 }).notNull().unique(),
  // Lower-cased copy so "Magnus" and "magnus" can't both register.
  usernameKey: varchar('username_key', { length: 20 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isBanned: boolean('is_banned').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ratings = pgTable(
  'ratings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    timeClass: timeClassEnum('time_class').notNull(),
    rating: real('rating').notNull().default(1500),
    deviation: real('deviation').notNull().default(350),
    volatility: real('volatility').notNull().default(0.06),
    gamesPlayed: integer('games_played').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.timeClass] })],
);

export const games = pgTable(
  'games',
  {
    id: varchar('id', { length: 12 }).primaryKey(),
    whiteId: uuid('white_id')
      .notNull()
      .references(() => users.id),
    blackId: uuid('black_id')
      .notNull()
      .references(() => users.id),
    timeControl: varchar('time_control', { length: 10 }).notNull(),
    timeClass: timeClassEnum('time_class').notNull(),
    rated: boolean('rated').notNull().default(true),
    status: gameStatusEnum('status').notNull().default('active'),
    result: varchar('result', { length: 7 }).notNull().default('*'),
    endReason: varchar('end_reason', { length: 32 }),
    pgn: text('pgn'),
    finalFen: text('final_fen'),
    whiteRatingBefore: integer('white_rating_before'),
    whiteRatingAfter: integer('white_rating_after'),
    blackRatingBefore: integer('black_rating_before'),
    blackRatingAfter: integer('black_rating_after'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('games_white_idx').on(t.whiteId, t.endedAt), index('games_black_idx').on(t.blackId, t.endedAt)],
);

export const moves = pgTable(
  'moves',
  {
    gameId: varchar('game_id', { length: 12 })
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    uci: varchar('uci', { length: 5 }).notNull(),
    san: varchar('san', { length: 10 }).notNull(),
    clockMs: integer('clock_ms').notNull(),
  },
  // One row per (game, ply): a duplicate move is impossible at the database level.
  (t) => [primaryKey({ columns: [t.gameId, t.ply] })],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only a SHA-256 hash is stored, so a leaked table can't be used to log in.
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    // All tokens from one login share a family; reuse of a rotated token revokes the family.
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_family_idx').on(t.familyId)],
);
