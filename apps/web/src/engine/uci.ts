/** Parsing Stockfish's UCI text output. Pure functions, so they're easy to test. */

export type Score = { type: 'cp'; value: number } | { type: 'mate'; value: number };

export interface InfoLine {
  depth: number;
  multipv: number;
  /** Score from the SIDE TO MOVE's point of view, as UCI reports it. */
  score: Score;
  pv: string[];
}

/** Parses "info depth 18 ... score cp 34 ... pv e2e4 e7e5 ..."; returns null for other info lines. */
export function parseInfo(line: string): InfoLine | null {
  if (!line.startsWith('info ') || !line.includes(' score ') || !line.includes(' pv ')) return null;
  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score: Score | null = null;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') depth = Number(tokens[++i]);
    else if (t === 'multipv') multipv = Number(tokens[++i]);
    else if (t === 'score') {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      if (kind === 'cp' || kind === 'mate') score = { type: kind, value };
      // "lowerbound"/"upperbound" may follow; skip them.
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') i++;
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1).filter(Boolean);
      break;
    }
  }
  if (!score || !Number.isFinite(depth) || pv.length === 0) return null;
  return { depth, multipv, score, pv };
}

/** "bestmove e2e4 ponder e7e5" -> "e2e4"; "bestmove (none)" -> null (no legal moves). */
export function parseBestMove(line: string): string | null | undefined {
  if (!line.startsWith('bestmove')) return undefined;
  const move = line.split(/\s+/)[1];
  return !move || move === '(none)' ? null : move;
}

/** Flips a side-to-move score to White's point of view. */
export function toWhitePov(score: Score, sideToMove: 'w' | 'b'): Score {
  return sideToMove === 'w' ? score : { type: score.type, value: -score.value } as Score;
}

/** Centipawns for charts and maths; a forced mate counts as a huge advantage that shrinks with distance. */
export function scoreToCp(score: Score): number {
  if (score.type === 'cp') return score.value;
  if (score.value === 0) return 0; // shouldn't happen for white-POV scores; caller handles mated positions
  return Math.sign(score.value) * (10_000 - Math.abs(score.value) * 10);
}

export function formatScore(score: Score): string {
  if (score.type === 'mate') return score.value > 0 ? `M${score.value}` : `-M${Math.abs(score.value)}`;
  const pawns = score.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}
