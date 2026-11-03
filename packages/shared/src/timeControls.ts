/**
 * Time controls are written "base+increment" in seconds, like chess.com:
 * "300+3" means 5 minutes each, plus 3 seconds added after every move.
 */
export const TIME_CONTROLS = [
  '60+0',
  '120+1',
  '180+0',
  '180+2',
  '300+0',
  '300+3',
  '600+0',
  '600+5',
  '900+10',
] as const;

export type TimeControlKey = (typeof TIME_CONTROLS)[number];
export type TimeClass = 'bullet' | 'blitz' | 'rapid';
export const TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid'];

export interface TimeControl {
  key: TimeControlKey;
  initialMs: number;
  incrementMs: number;
  timeClass: TimeClass;
  label: string;
}

export function isTimeControlKey(value: string): value is TimeControlKey {
  return (TIME_CONTROLS as readonly string[]).includes(value);
}

/**
 * Classify by expected game length (base + 40 moves of increment),
 * the same rule chess.com and Lichess use, so ratings stay comparable.
 */
export function timeClassOf(initialSec: number, incrementSec: number): TimeClass {
  const expected = initialSec + 40 * incrementSec;
  if (expected < 180) return 'bullet';
  if (expected < 480) return 'blitz';
  return 'rapid';
}

export function parseTimeControl(key: TimeControlKey): TimeControl {
  const [base, inc] = key.split('+').map(Number) as [number, number];
  return {
    key,
    initialMs: base * 1000,
    incrementMs: inc * 1000,
    timeClass: timeClassOf(base, inc),
    label: `${base / 60} | ${inc}`,
  };
}
