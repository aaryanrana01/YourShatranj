import { type MoveClass, winPercent } from '../engine/review';
import { MOVE_STYLE } from './MoveBadge';

/**
 * White's winning chances over the game: the white area is White's share.
 * Coloured dots mark inaccuracies, mistakes and blunders; click to jump.
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
  const H = 120;
  const step = W / (evalsCp.length - 1);
  const y = (cp: number) => H - (winPercent(cp) / 100) * H;
  const line = evalsCp.map((cp, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ply = Math.round(((e.clientX - rect.left) / rect.width) * (evalsCp.length - 1));
    onSelect(Math.max(0, Math.min(evalsCp.length - 1, ply)));
  };

  return (
    <div className="relative h-24 w-full cursor-pointer overflow-hidden rounded-lg bg-[#403d39]" onClick={pick} role="img" aria-label="Evaluation graph">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <path d={area} fill="#ffffff" opacity={0.92} />
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#8a857c" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
        <line x1={current * step} x2={current * step} y1={0} y2={H} stroke="var(--color-go-hi)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Dots are HTML so they stay round while the SVG stretches. */}
      {classes.map((c, i) =>
        c === 'inaccuracy' || c === 'mistake' || c === 'blunder' ? (
          <span
            key={i}
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#403d39]"
            style={{
              left: `${(((i + 1) * step) / W) * 100}%`,
              top: `${(y(evalsCp[i + 1] ?? 0) / H) * 100}%`,
              background: MOVE_STYLE[c].color,
            }}
          />
        ) : null,
      )}
    </div>
  );
}
