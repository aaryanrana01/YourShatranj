/**
 * Seconds each player spent on each move, read from the PGN's [%clk] comments.
 * White's moves rise above the centre line, Black's hang below it, so long
 * thinks (and time trouble) stand out at a glance.
 */
export function TimeChart({
  spent,
  current,
  onSelect,
}: {
  spent: (number | null)[];
  current: number;
  onSelect: (ply: number) => void;
}) {
  const known = spent.filter((s): s is number => s !== null);
  if (known.length < 4) return null;
  const max = Math.max(...known, 1);
  const longest = spent.indexOf(max);
  return (
    <div>
      <div className="relative flex h-28 items-center gap-px rounded-lg bg-felt/70 px-1" role="img" aria-label="Time spent per move">
        <div className="absolute left-1 right-1 top-1/2 h-px bg-line" />
        {spent.map((s, i) => {
          const h = s === null ? 0 : Math.max(2, (s / max) * 48);
          const white = i % 2 === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i + 1)}
              className="relative flex h-full flex-1 flex-col justify-center"
              title={s === null ? undefined : `Move ${Math.floor(i / 2) + 1}${white ? '' : '…'}: ${s.toFixed(1)} s`}
            >
              <span
                className={`absolute left-0 right-0 rounded-[1px] ${current === i + 1 ? 'bg-go-hi' : white ? 'bg-ink' : 'bg-faint'}`}
                style={white ? { bottom: '50%', height: `${h}%` } : { top: '50%', height: `${h}%` }}
              />
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted">
        Longest think: {max.toFixed(0)} s on move {Math.floor(longest / 2) + 1} ({longest % 2 === 0 ? 'White' : 'Black'}).
      </p>
    </div>
  );
}

/** "0:04:58.3" → seconds */
function parseClk(text: string): number | null {
  const m = text.match(/\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Time spent per move from clock readings after each move:
 * spent = clock before the move − clock after + increment.
 */
export function timeSpent(clockComments: (string | undefined)[], timeControl: string | undefined): (number | null)[] {
  const tc = timeControl?.match(/^(\d+)(?:\+(\d+))?$/);
  if (!tc) return clockComments.map(() => null);
  const base = Number(tc[1]);
  const inc = Number(tc[2] ?? 0);
  const last = { w: base, b: base };
  return clockComments.map((c, i) => {
    const side = i % 2 === 0 ? 'w' : 'b';
    const now = c ? parseClk(c) : null;
    if (now === null) return null;
    const spent = Math.max(0, last[side] - now + inc);
    last[side] = now;
    return spent;
  });
}
