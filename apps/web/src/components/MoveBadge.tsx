import type { MoveClass } from '../engine/review';

/** Label, glyph and colour for each move classification, used everywhere a move is rated. */
export const MOVE_STYLE: Record<MoveClass, { label: string; glyph: string; color: string }> = {
  best: { label: 'Best', glyph: '★', color: 'var(--color-best)' },
  excellent: { label: 'Excellent', glyph: '!', color: 'var(--color-excellent)' },
  good: { label: 'Good', glyph: '✓', color: 'var(--color-good)' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: 'var(--color-inaccuracy)' },
  mistake: { label: 'Mistake', glyph: '?', color: 'var(--color-mistake)' },
  blunder: { label: 'Blunder', glyph: '??', color: 'var(--color-blunder)' },
};

export const MOVE_CLASSES = Object.keys(MOVE_STYLE) as MoveClass[];

/** Round badge with the move's glyph, e.g. a red "??" for a blunder. */
export function MoveBadge({ kind, size = 'md' }: { kind: MoveClass; size?: 'sm' | 'md' }) {
  const s = MOVE_STYLE[kind];
  const dim = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-white ${dim}`}
      style={{ background: s.color }}
      title={s.label}
      aria-label={s.label}
    >
      {s.glyph}
    </span>
  );
}
