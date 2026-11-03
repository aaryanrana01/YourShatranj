import type {
  Color,
  EndReason,
  GameResult,
  GameStatus,
  MoveRecord,
  PlayerInfo,
  TimeClass,
  TimeControlKey,
} from '@chess/shared';

/** The full game record the server keeps in Redis while a game is live. */
export interface StoredGame {
  id: string;
  white: PlayerInfo;
  black: PlayerInfo;
  timeControl: TimeControlKey;
  timeClass: TimeClass;
  initialMs: number;
  incrementMs: number;
  rated: boolean;
  status: GameStatus;
  fen: string;
  moves: MoveRecord[];
  /** Remaining time for each side as of `turnStartedAt`. */
  clocks: { w: number; b: number };
  /** Server time when the side to move started thinking. */
  turnStartedAt: number;
  createdAt: number;
  drawOffer: Color | null;
  drawOffersUsed: { w: number; b: number };
  /** Ply at which each side last offered a draw (stops offer spam). */
  lastDrawOfferPly: { w: number; b: number };
  disconnectedAt: { w: number | null; b: number | null };
  result: GameResult;
  endReason: EndReason | null;
  endedAt: number | null;
  ratingChanges: { w: number; b: number } | null;
  /** True once the finished game has been written to Postgres. */
  persisted: boolean;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Side to move after `ply` half-moves. */
export function turnAt(ply: number): Color {
  return ply % 2 === 0 ? 'w' : 'b';
}

export function colorOf(game: StoredGame, userId: string): Color | null {
  if (game.white.id === userId) return 'w';
  if (game.black.id === userId) return 'b';
  return null;
}

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}
