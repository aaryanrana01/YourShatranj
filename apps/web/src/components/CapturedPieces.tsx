import { useMemo } from 'react';
import { type PieceKind, materialBalance } from '../lib/material';

/** Small piece silhouettes (20×20), drawn for this site. */
const PATHS: Record<PieceKind, string> = {
  p: 'M10 3.2a2.9 2.9 0 1 1 0 5.8a2.9 2.9 0 1 1 0-5.8zM7.3 10h5.4l1.5 5.4H5.8zM5 15.8h10v2.5H5z',
  n: 'M5.5 18.3v-2.2c0-2.3 1.7-3.6 3.3-4.9-1.5.5-2.6.4-3.5 1.3L4 11.1c.7-2.6 2.6-5.6 5.4-6.9l.8-2 1.3 1.7c3 .9 4.6 4.2 4.6 8.1v6.3z',
  b: 'M10 1.9a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 1 1 0-2.8zM10 5.1c2.6 1.5 3.8 3.5 3.8 5.5 0 1.9-1.3 3.1-3.8 3.1s-3.8-1.2-3.8-3.1c0-2 1.2-4 3.8-5.5zM6.8 14.6h6.4l.9 1.5H5.9zM5 16.5h10v1.9H5z',
  r: 'M5 3h2.2v2h1.7V3h2.2v2h1.7V3H15v4.2l-1.9 1.4v5.8l1.9 1.1v2.8H5v-2.8l1.9-1.1V8.6L5 7.2z',
  q: 'M3.6 5.2a1.3 1.3 0 1 1 0 .1zM10 2.7a1.3 1.3 0 1 1 0 .1zM16.4 5.2a1.3 1.3 0 1 1 0 .1zM3.8 7.3l2.1 6.9h8.2l2.1-6.9-3.6 3.1L10 4.9l-2.6 5.5zM5.6 15h8.8v1.3H5.6zM5 16.9h10v1.6H5z',
};

const NAME: Record<PieceKind, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

function Piece({ kind, color }: { kind: PieceKind; color: 'w' | 'b' }) {
  return (
    <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] shrink-0" aria-hidden="true">
      <path
        d={PATHS[kind]}
        fill={color === 'w' ? '#f1efe9' : '#1d1c1a'}
        stroke={color === 'w' ? '#1d1c1a' : '#a8a399'}
        strokeWidth={color === 'w' ? 1.2 : 1}
        strokeLinejoin="round"
        fillRule="nonzero"
      />
    </svg>
  );
}

/**
 * The pieces `side` has captured, grouped by type (like chess.com), followed
 * by "+N" when that side is ahead in material.
 */
export function CapturedPieces({ fen, side }: { fen: string; side: 'w' | 'b' }) {
  const { captured, diff } = useMemo(() => materialBalance(fen), [fen]);
  const taken = captured[side];
  const lead = side === 'w' ? diff : -diff;
  const opponent = side === 'w' ? 'b' : 'w';

  if (taken.length === 0 && lead <= 0) return null;

  // Group identical pieces so they overlap slightly, keeping the row short.
  const groups: { kind: PieceKind; n: number }[] = [];
  for (const kind of taken) {
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.n += 1;
    else groups.push({ kind, n: 1 });
  }
  const summary = [
    groups.map((g) => `${g.n} ${NAME[g.kind]}${g.n > 1 ? 's' : ''}`).join(', ') || 'nothing',
    lead > 0 ? `ahead by ${lead}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <span className="flex items-center gap-1.5" title={`Captured: ${summary}`}>
      <span className="sr-only">Captured: {summary}</span>
      {groups.length > 0 ? (
        <span className="flex items-center gap-0.5" aria-hidden="true">
          {groups.map((g) => (
            <span key={g.kind} className="flex items-center">
              {Array.from({ length: g.n }, (_, i) => (
                <span key={i} className={i > 0 ? '-ml-[7px]' : ''}>
                  <Piece kind={g.kind} color={opponent} />
                </span>
              ))}
            </span>
          ))}
        </span>
      ) : null}
      {lead > 0 ? (
        <span className="tabular text-[13px] font-bold text-ink/80" aria-hidden="true">
          +{lead}
        </span>
      ) : null}
    </span>
  );
}
