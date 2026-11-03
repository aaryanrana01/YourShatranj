import { useEffect, useState } from 'react';
import { formatClock } from '../lib/format';

/**
 * Counts down locally for smoothness, from the last value the server sent
 * (`ms` at local time `syncedAt`). The server's numbers always win: every
 * server message resets `ms` and `syncedAt`.
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
      className={`min-w-28 rounded-lg px-4 py-2 text-right font-mono text-2xl font-bold tabular-nums transition ${
        running ? (low ? 'bg-blunder text-white' : 'bg-ink-200 text-ink-950') : 'bg-ink-800 text-ink-400'
      }`}
    >
      {formatClock(shown)}
    </div>
  );
}
