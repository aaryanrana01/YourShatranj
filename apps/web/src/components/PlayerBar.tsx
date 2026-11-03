import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The strip above and below the board: avatar square, name, rating, and
 * whatever the page adds on the right (a clock, an accuracy score).
 */
export function PlayerBar({
  name,
  rating,
  color,
  linkToProfile = false,
  note,
  right,
}: {
  name: string;
  rating?: number | string | null;
  color: 'w' | 'b';
  linkToProfile?: boolean;
  note?: ReactNode;
  right?: ReactNode;
}) {
  const initial = name.slice(0, 1).toUpperCase() || '?';
  const label = (
    <span className="truncate font-bold text-ink">{name}</span>
  );
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-extrabold ${
            color === 'w' ? 'bg-ink text-felt' : 'bg-[#1d1c1a] text-ink ring-1 ring-line'
          }`}
          aria-hidden
        >
          {initial}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="flex items-baseline gap-1.5">
            {linkToProfile ? (
              <Link to={`/u/${name}`} className="truncate hover:underline">
                {label}
              </Link>
            ) : (
              label
            )}
            {rating !== undefined && rating !== null && rating !== '' ? (
              <span className="tabular text-sm text-muted">({rating})</span>
            ) : null}
          </div>
          {note ? <div className="text-xs text-muted">{note}</div> : null}
        </div>
      </div>
      {right}
    </div>
  );
}
