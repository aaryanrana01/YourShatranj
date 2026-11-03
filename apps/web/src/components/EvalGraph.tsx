import { CLASS_STYLE, type MoveClass, winPercent } from '../engine/review';

/**
 * White's win chance after every move. The light area is White's share, the
 * vertical lines mark mistakes and blunders. Click to jump to a move.
 */
export function EvalGraph({
  evalsCp,
  current,
  onSelect,
  classes,
}: {
  evalsCp: number[];
  current: number;
  onSelect: (ply: number) => void;
  classes: (MoveClass | undefined)[];
}) {
  if (evalsCp.length < 2) return null;
  const W = 1000;
  const H = 100;
  const step = W / (evalsCp.length - 1);
  const y = (cp: number) => H - (winPercent(cp) / 100) * H;
  const line = evalsCp.map((cp, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-24 w-full cursor-pointer rounded-lg bg-ink-700"
      role="img"
      aria-label="Evaluation graph"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ply = Math.round(((e.clientX - rect.left) / rect.width) * (evalsCp.length - 1));
        onSelect(Math.max(0, Math.min(evalsCp.length - 1, ply)));
      }}
    >
      <path d={area} fill="var(--color-ink-200)" opacity={0.9} />
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--color-ink-400)" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
      {classes.map((c, i) =>
        c === 'mistake' || c === 'blunder' || c === 'inaccuracy' ? (
          <line
            key={i}
            x1={(i + 1) * step}
            x2={(i + 1) * step}
            y1={0}
            y2={H}
            stroke={CLASS_STYLE[c].color}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            opacity={c === 'inaccuracy' ? 0.5 : 0.9}
          />
        ) : null,
      )}
      <line x1={current * step} x2={current * step} y1={0} y2={H} stroke="var(--color-amber-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
