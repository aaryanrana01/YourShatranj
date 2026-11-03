import type { ErrorCode } from '@chess/shared';

/** An expected failure the client should hear about (illegal move, not your turn, ...). */
export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
