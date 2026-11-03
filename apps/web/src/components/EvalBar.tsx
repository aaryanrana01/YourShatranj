import { winPercent } from '../engine/review';

/** Text for a White-POV centipawn value: "0.4", "M3", or the result once the game is decided by mate. */
export function evalLabel(cp: number): string {
  if (Math.abs(cp) >= 9000) {
    const mateIn = Math.round((10_000 - Math.abs(cp)) / 10);
    if (mateIn === 0) return cp > 0 ? '1-0' : '0-1';
    return `${cp > 0 ? '' : '-'}M${mateIn}`;
  }
  return (cp / 100).toFixed(1);
}

/** Vertical bar beside the board: the white part's height is White's chance of winning. */
export function EvalBar({ cp, label, orientation }: { cp: number | null; label?: string; orientation: 'white' | 'black' }) {
  const whitePct = cp === null ? 50 : winPercent(cp);
  const whiteOnBottom = orientation === 'white';
  const text = cp === null ? '' : (label ?? evalLabel(cp)).replace('+', '').replace(/^-/, '');
  const whiteAhead = whitePct >= 50;
  return (
    <div
      className="relative w-7 shrink-0 overflow-hidden rounded-sm bg-[#403d39]"
      role="meter"
      aria-label="Evaluation"
      aria-valuenow={Math.round(whitePct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="absolute left-0 right-0 bg-white transition-[height] duration-300"
        style={whiteOnBottom ? { bottom: 0, height: `${whitePct}%` } : { top: 0, height: `${whitePct}%` }}
      />
      {/* The number sits at the leading side's end, in that side's colour scheme. */}
      <span
        className={`tabular absolute left-0 right-0 text-center text-[10px] font-extrabold ${
          whiteAhead === whiteOnBottom ? 'bottom-1' : 'top-1'
        } ${whiteAhead ? 'text-[#403d39]' : 'text-white'}`}
      >
        {text}
      </span>
    </div>
  );
}
