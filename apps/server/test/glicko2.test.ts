import { describe, expect, it } from 'vitest';
import { DEFAULT_GLICKO, rateGame, updateGlicko } from '../src/game/glicko2.js';

describe('Glicko-2', () => {
  it("matches the worked example in Glickman's paper", () => {
    const next = updateGlicko(
      { rating: 1500, deviation: 200, volatility: 0.06 },
      [
        { opponent: { rating: 1400, deviation: 30, volatility: 0.06 }, score: 1 },
        { opponent: { rating: 1550, deviation: 100, volatility: 0.06 }, score: 0 },
        { opponent: { rating: 1700, deviation: 300, volatility: 0.06 }, score: 0 },
      ],
      false,
    );
    expect(next.rating).toBeCloseTo(1464.06, 1);
    expect(next.deviation).toBeCloseTo(151.52, 1);
    expect(next.volatility).toBeCloseTo(0.05999, 4);
  });

  it('moves new players more than established ones', () => {
    const newbie = { ...DEFAULT_GLICKO };
    const veteran = { rating: 1500, deviation: 60, volatility: 0.06 };
    const a = rateGame(newbie, veteran, 1);
    expect(a.white.rating - 1500).toBeGreaterThan(1500 - a.black.rating);
  });

  it('is zero-sum-ish for equal players and a draw changes nothing', () => {
    const p = { rating: 1500, deviation: 80, volatility: 0.06 };
    const draw = rateGame(p, p, 0.5);
    expect(draw.white.rating).toBeCloseTo(1500, 5);
    const win = rateGame(p, p, 1);
    expect(win.white.rating - 1500).toBeCloseTo(1500 - win.black.rating, 5);
  });
});
