import type { TimeControlKey, TimeClass } from './timeControls.js';

export type Color = 'w' | 'b';
export type GameStatus = 'active' | 'ended' | 'aborted';
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export type EndReason =
  | 'checkmate'
  | 'resign'
  | 'timeout'
  | 'timeout_vs_insufficient'
  | 'stalemate'
  | 'repetition'
  | 'fifty_move'
  | 'insufficient_material'
  | 'agreement'
  | 'abandoned'
  | 'aborted';

export interface PlayerInfo {
  id: string;
  username: string;
  rating: number;
}

export interface MoveRecord {
  uci: string;
  san: string;
  /** Mover's remaining time right after this move, in ms. */
  clockMs: number;
}

/**
 * What every client sees about a game. The server builds this from its own
 * stored state; clients never send any of these fields back as truth.
 */
export interface PublicGameState {
  id: string;
  white: PlayerInfo;
  black: PlayerInfo;
  timeControl: TimeControlKey;
  timeClass: TimeClass;
  rated: boolean;
  status: GameStatus;
  fen: string;
  moves: MoveRecord[];
  ply: number;
  turn: Color;
  /** Remaining time for each side, computed at `serverNow`. */
  clocks: { w: number; b: number };
  /** False until both sides have made their first move. */
  clockRunning: boolean;
  serverNow: number;
  drawOffer: Color | null;
  /** Epoch ms when each player disconnected, or null if connected. */
  disconnectedAt: { w: number | null; b: number | null };
  /** Epoch ms after which the opponent of a disconnected player may claim the win. */
  claimWinAt: { w: number | null; b: number | null };
  /** Epoch ms when the game is auto-aborted if the side to move hasn't made a first move. */
  abortAt: number | null;
  result: GameResult;
  endReason: EndReason | null;
  ratingChanges: { w: number; b: number } | null;
}

export interface GameMovedEvent {
  gameId: string;
  move: MoveRecord;
  ply: number;
  fen: string;
  clocks: { w: number; b: number };
  clockRunning: boolean;
  serverNow: number;
  drawOffer: Color | null;
  abortAt: number | null;
}

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'NOT_YOUR_GAME'
  | 'NOT_YOUR_TURN'
  | 'GAME_OVER'
  | 'ILLEGAL_MOVE'
  | 'STALE_PLY'
  | 'ALREADY_IN_GAME'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'NOT_ALLOWED'
  | 'INTERNAL';

export type Ack<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorCode; message: string };

export interface UserPublic {
  id: string;
  username: string;
  createdAt: string;
  ratings: Record<TimeClass, { rating: number; deviation: number; games: number }>;
}

export interface GameSummary {
  id: string;
  white: string;
  black: string;
  result: GameResult;
  endReason: EndReason | null;
  timeControl: string;
  rated: boolean;
  endedAt: string | null;
  whiteRatingDelta: number | null;
  blackRatingDelta: number | null;
}

export interface ChessComGame {
  url: string;
  pgn: string;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
  timeClass: string;
  timeControl: string;
  rules: string;
  endTime: number;
  /** chess.com's own accuracy, present only if the game was reviewed on chess.com. */
  accuracies: { white: number; black: number } | null;
}
