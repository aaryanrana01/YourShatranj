import { describe, expect, it } from 'vitest';
import {
  abortDeadline,
  chargeMove,
  clocksAt,
  hasFlagged,
  lagCredit,
  nextDeadline,
} from '../src/game/clock.js';
import { FIRST_MOVE_TIMEOUT_MS, MAX_LAG_CREDIT_MS } from '../src/game/constants.js';
import { START_FEN, type StoredGame } from '../src/game/types.js';

function game(overrides: Partial<StoredGame> = {}): StoredGame {
  return {
    id: 'abcdefghijkl',
    white: { id: 'w', username: 'white', rating: 1500 },
    black: { id: 'b', username: 'black', rating: 1500 },
    timeControl: '180+2',
    timeClass: 'blitz',
    initialMs: 180_000,
    incrementMs: 2_000,
    rated: true,
    status: 'active',
    fen: START_FEN,
    moves: [],
    clocks: { w: 180_000, b: 180_000 },
    turnStartedAt: 1_000_000,
    createdAt: 1_000_000,
    drawOffer: null,
    drawOffersUsed: { w: 0, b: 0 },
    lastDrawOfferPly: { w: -1, b: -1 },
    disconnectedAt: { w: null, b: null },
    result: '*',
    endReason: null,
    endedAt: null,
    ratingChanges: null,
    persisted: false,
    ...overrides,
  };
}

const twoMoves = [
  { uci: 'e2e4', san: 'e4', clockMs: 180_000 },
  { uci: 'e7e5', san: 'e5', clockMs: 180_000 },
];

describe('clock', () => {
  it('first moves cost no time and earn no increment', () => {
    const g = game();
    const res = chargeMove(g, g.turnStartedAt + 20_000, 0);
    expect(res).toEqual({ flagged: false, remainingMs: 180_000 });
  });

  it('charges elapsed time and adds the increment once the clock runs', () => {
    const g = game({ moves: twoMoves });
    const res = chargeMove(g, g.turnStartedAt + 10_000, 0);
    expect(res).toEqual({ flagged: false, remainingMs: 180_000 - 10_000 + 2_000 });
  });

  it('credits lag but never more than the cap', () => {
    expect(lagCredit(100)).toBe(50);
    expect(lagCredit(10_000)).toBe(MAX_LAG_CREDIT_MS);
    expect(lagCredit(undefined)).toBe(0);
    const g = game({ moves: twoMoves });
    const res = chargeMove(g, g.turnStartedAt + 10_000, lagCredit(10_000));
    expect(res).toEqual({ flagged: false, remainingMs: 180_000 - (10_000 - MAX_LAG_CREDIT_MS) + 2_000 });
  });

  it('flags a move that arrives after time ran out', () => {
    const g = game({ moves: twoMoves, clocks: { w: 5_000, b: 180_000 } });
    expect(chargeMove(g, g.turnStartedAt + 5_001, 0)).toEqual({ flagged: true });
  });

  it('timer only flags after the maximum possible lag credit', () => {
    const g = game({ moves: twoMoves, clocks: { w: 5_000, b: 180_000 } });
    expect(hasFlagged(g, g.turnStartedAt + 5_000)).toBe(false);
    expect(hasFlagged(g, g.turnStartedAt + 5_000 + MAX_LAG_CREDIT_MS)).toBe(true);
  });

  it('shows the running clock only for the side to move', () => {
    const g = game({ moves: twoMoves });
    expect(clocksAt(g, g.turnStartedAt + 3_000)).toEqual({ w: 177_000, b: 180_000 });
  });

  it('schedules the abort check before both sides have moved, then the flag check', () => {
    const g = game();
    expect(abortDeadline(g)).toBe(g.turnStartedAt + FIRST_MOVE_TIMEOUT_MS);
    expect(nextDeadline(g)).toBe(g.turnStartedAt + FIRST_MOVE_TIMEOUT_MS);
    const running = game({ moves: twoMoves });
    expect(abortDeadline(running)).toBeNull();
    expect(nextDeadline(running)).toBe(running.turnStartedAt + 180_000 + MAX_LAG_CREDIT_MS);
  });
});
