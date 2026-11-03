import type { EndReason, GameResult } from '@chess/shared';

/** 3:05 above 20 s, 9.4 with tenths in the last 20 seconds (like most chess sites). */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 20_000) return (Math.floor(clamped / 100) / 10).toFixed(1);
  const total = Math.ceil(clamped / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const REASONS: Record<EndReason, string> = {
  checkmate: 'by checkmate',
  resign: 'by resignation',
  timeout: 'on time',
  timeout_vs_insufficient: 'timeout vs insufficient material',
  stalemate: 'by stalemate',
  repetition: 'by repetition',
  fifty_move: 'by the 50-move rule',
  insufficient_material: 'by insufficient material',
  agreement: 'by agreement',
  abandoned: 'by abandonment',
  aborted: 'aborted',
};

export function describeResult(result: GameResult, reason: EndReason | null, white: string, black: string): string {
  if (reason === 'aborted') return 'Game aborted';
  const why = reason ? REASONS[reason] : '';
  if (result === '1-0') return `${white} won ${why}`;
  if (result === '0-1') return `${black} won ${why}`;
  if (result === '1/2-1/2') return `Draw ${why}`;
  return 'Game over';
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
