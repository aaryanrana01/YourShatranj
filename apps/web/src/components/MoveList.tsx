import { useEffect, useRef } from 'react';
import type { MoveClass } from '../engine/review';
import { MoveBadge } from './MoveBadge';

/**
 * Moves in numbered pairs. `current` is how many moves are applied on the
 * board (0 = start position), so the highlighted move is moves[current - 1].
 * Inaccuracies, mistakes and blunders show their badge next to the move.
 */
export function MoveList({
  moves,
  current,
  onSelect,
  classes,
  maxHeight = 'max-h-72',
}: {
  moves: { san: string }[];
  current: number;
  onSelect?: (ply: number) => void;
  classes?: (MoveClass | undefined)[];
  maxHeight?: string;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Keep the current move visible by scrolling ONLY this list's own box.
  // (scrollIntoView would also scroll the page, which on phones yanks the
  // board off-screen after every move, because the list sits below it.)
  useEffect(() => {
    const box = boxRef.current;
    const active = activeRef.current;
    if (!box) return;
    if (!active) {
      if (current === 0) box.scrollTop = 0;
      return;
    }
    const boxRect = box.getBoundingClientRect();
    const rowRect = active.getBoundingClientRect();
    if (rowRect.top < boxRect.top) box.scrollTop -= boxRect.top - rowRect.top + 4;
    else if (rowRect.bottom > boxRect.bottom) box.scrollTop += rowRect.bottom - boxRect.bottom + 4;
  }, [current, moves.length]);

  const rows: { n: number; w?: number; b?: number }[] = [];
  for (let i = 0; i < moves.length; i += 2) rows.push({ n: i / 2 + 1, w: i, b: i + 1 < moves.length ? i + 1 : undefined });

  const cell = (i: number | undefined) => {
    if (i === undefined) return <span />;
    const cls = classes?.[i];
    const flagged = cls === 'inaccuracy' || cls === 'mistake' || cls === 'blunder';
    const active = current === i + 1;
    return (
      <button
        ref={active ? activeRef : undefined}
        type="button"
        onClick={() => onSelect?.(i + 1)}
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-left text-[15px] font-semibold ${
          active ? 'bg-line text-ink' : 'text-ink/90 hover:bg-raised'
        }`}
      >
        {flagged && cls ? <MoveBadge kind={cls} size="sm" /> : null}
        <span>{moves[i]!.san}</span>
      </button>
    );
  };

  return (
    <div ref={boxRef} className={`${maxHeight} overflow-y-auto`}>
      {rows.length === 0 ? <p className="px-2 py-3 text-sm text-muted">No moves yet.</p> : null}
      {rows.map((r) => (
        <div key={r.n} className={`grid grid-cols-[2.5rem_1fr_1fr] items-center gap-1 px-1 ${r.n % 2 === 0 ? 'bg-white/[0.025]' : ''}`}>
          <span className="tabular text-right text-sm text-faint">{r.n}.</span>
          {cell(r.w)}
          {cell(r.b)}
        </div>
      ))}
    </div>
  );
}
