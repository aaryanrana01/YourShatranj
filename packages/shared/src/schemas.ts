import { z } from 'zod';
import { TIME_CONTROLS } from './timeControls.js';

/**
 * Every input that crosses the network is checked against one of these
 * schemas before any other code sees it. `.strict()` rejects unknown fields,
 * so a client can't sneak extra properties (like `userId`) into a payload.
 */

export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(20, 'Username must be at most 20 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, digits, _ and -');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  // Argon2 cost grows with input length; a cap stops huge-password DoS.
  .max(128, 'Password must be at most 128 characters');

export const registerSchema = z.object({ username: usernameSchema, password: passwordSchema }).strict();
/** Finishing a Google sign-up: the only thing the new user chooses is a username. */
export const googleCompleteSchema = z.object({ username: usernameSchema }).strict();
export const loginSchema = z
  .object({ username: z.string().min(1).max(20), password: z.string().min(1).max(128) })
  .strict();

/** Game IDs are 12 URL-safe random characters (nanoid). */
export const gameIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/, 'Invalid game id');

/** UCI move: from-square, to-square, optional promotion piece. e.g. "e2e4", "e7e8q". */
export const uciSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'Invalid move format');

export const queueJoinSchema = z.object({ timeControl: z.enum(TIME_CONTROLS) }).strict();
export const gameRefSchema = z.object({ gameId: gameIdSchema }).strict();
export const moveSchema = z
  .object({ gameId: gameIdSchema, uci: uciSchema, ply: z.number().int().min(0).max(1000) })
  .strict();
export const drawRespondSchema = z.object({ gameId: gameIdSchema, accept: z.boolean() }).strict();

/** chess.com usernames: letters, digits, _ and -, up to 25 characters. */
export const chessComUsernameSchema = z.string().regex(/^[A-Za-z0-9_-]{2,25}$/, 'Invalid chess.com username');
export const archiveMonthSchema = z.object({
  year: z.coerce.number().int().min(2007).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type QueueJoinInput = z.infer<typeof queueJoinSchema>;
export type MoveInput = z.infer<typeof moveSchema>;
export type GameRefInput = z.infer<typeof gameRefSchema>;
export type DrawRespondInput = z.infer<typeof drawRespondSchema>;
