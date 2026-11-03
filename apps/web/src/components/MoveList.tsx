import { useEffect, useRef } from 'react';
import { CLASS_STYLE, type MoveClass } from '../engine/review';

/**
 * Moves in numbered pairs. `current` is how many moves are applied on the
 * board (0 = start position), so the highlighted move is moves[current - 1].
 */
export function MoveList({
  moves,
  current,
  onSelect,
  classes,
}: {
  moves: { san: string }[];
  current: number;
  onSelect?: (ply: number) => void;
  classes?: (MoveClass | undefined)[];
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const rows: { n: number; w?: number; b?: number }[] = [];
  for (let i = 0; i < moves.length; i += 2) rows.push({ n: i / 2 + 1, w: i, b: i + 1 < moves.length ? i + 1 : undefined });

  const cell = (i: number | undefined) => {
    if (i === undefined) return <span />;
    const cls = classes?.[i];
    const style = cls ? CLASS_STYLE[cls] : null;
    const active = current === i + 1;
    return (
      <button
        ref={active ? activeRef : undefined}
        type="button"
        onClick={() => onSelect?.(i + 1)}
        className={`flex items-center justify-between rounded px-2 py-1 text-left font-mono text-sm ${
          active ? 'bg-amber-accent/25 text-white' : 'hover:bg-ink-700'
        }`}
      >
        <span>{moves[i]!.san}</span>
        {style && cls !== 'best' && cls !== 'excellent' && cls !== 'good' ? (
          <span className="text-xs font-bold" style={{ color: style.color }} title={style.label}>
            {style.symbol}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="max-h-72 overflow-y-auto pr-1">
      {rows.length === 0 ? <p className="px-2 py-3 text-sm text-ink-400">No moves yet.</p> : null}
      {rows.map((r) => (
        <div key={r.n} className="grid grid-cols-[2.5rem_1fr_1fr] items-center gap-1">
          <span className="text-right font-mono text-xs text-ink-400">{r.n}.</span>
          {cell(r.w)}
          {cell(r.b)}
        </div>
      ))}
    </div>
  );
}
