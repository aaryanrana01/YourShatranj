/**
 * Glicko-2 rating system (Mark Glickman, "Example of the Glicko-2 system").
 * Lichess uses it too. Besides a rating, every player has:
 *  - deviation (RD): how unsure we are of the rating; new players start high,
 *    so their first games move their rating a lot.
 *  - volatility: how erratic the player's results are.
 * Each finished game is treated as one rating period with one opponent.
 */

export interface Glicko {
  rating: number;
  deviation: number;
  volatility: number;
}

export interface GameOutcome {
  opponent: Glicko;
  /** 1 win, 0.5 draw, 0 loss */
  score: number;
}

const SCALE = 173.7178;
/** Constrains volatility change; Glickman suggests 0.3–1.2. */
const TAU = 0.5;
const EPSILON = 0.000001;
const MIN_RD = 45;
const MAX_RD = 350;

export const DEFAULT_GLICKO: Glicko = { rating: 1500, deviation: 350, volatility: 0.06 };

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

export function updateGlicko(player: Glicko, outcomes: readonly GameOutcome[], clamp = true): Glicko {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.deviation / SCALE;
  const sigma = player.volatility;

  if (outcomes.length === 0) {
    // No games: only the uncertainty grows.
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { ...player, deviation: Math.min(MAX_RD, phiStar * SCALE) };
  }

  // Step 3–4: estimated variance v and improvement delta.
  let vInv = 0;
  let deltaSum = 0;
  for (const { opponent, score } of outcomes) {
    const muJ = (opponent.rating - 1500) / SCALE;
    const phiJ = opponent.deviation / SCALE;
    const e = expected(mu, muJ, phiJ);
    const gj = g(phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility via the Illinois algorithm.
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  // Step 6–7: new deviation and rating.
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  const deviation = newPhi * SCALE;
  return {
    rating: newMu * SCALE + 1500,
    deviation: clamp ? Math.min(MAX_RD, Math.max(MIN_RD, deviation)) : deviation,
    volatility: newSigma,
  };
}

/** Rating updates for both players of one game. `whiteScore` is 1, 0.5 or 0. */
export function rateGame(white: Glicko, black: Glicko, whiteScore: number): { white: Glicko; black: Glicko } {
  return {
    white: updateGlicko(white, [{ opponent: black, score: whiteScore }]),
    black: updateGlicko(black, [{ opponent: white, score: 1 - whiteScore }]),
  };
}
