import { useEffect, useState } from 'react';
import { formatClock } from '../lib/format';

/**
 * Counts down locally for smoothness, from the last value the server sent
 * (`ms` at local time `syncedAt`). The server's numbers always win: every
 * server message resets `ms` and `syncedAt`.
 * The running clock is a bright white box; under 20 s it turns red.
 */
export function Clock({ ms, running, syncedAt, label }: { ms: number; running: boolean; syncedAt: number; label: string }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [running]);

  const shown = running ? ms - (now - syncedAt) : ms;
  const low = shown < 20_000;
  return (
    <div
      aria-label={`${label} clock`}
      className={`tabular min-w-[7.5rem] rounded-md px-3 py-1.5 text-right text-[1.6rem] font-bold leading-none ${
        running ? (low ? 'bg-blunder text-white' : 'bg-ink text-felt') : 'bg-[#1d1c1a] text-muted'
      }`}
    >
      {formatClock(shown)}
    </div>
  );
}
