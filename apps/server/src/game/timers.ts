/**
 * One pending timer per game: the next moment the server must act on its own
 * (flag fall or abort). Timers live in memory; if the server restarts, the
 * startup recovery re-creates them from Redis. The timer callback re-reads the
 * game before doing anything, so a stale or duplicate timer is harmless.
 */
export class GameTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onFire: (gameId: string) => void) {}

  schedule(gameId: string, atMs: number | null, now = Date.now()): void {
    this.clear(gameId);
    if (atMs === null) return;
    // +5 ms so the check runs just after the deadline, never just before it.
    const delay = Math.max(0, atMs - now + 5);
    // setTimeout's max is ~24.8 days; chess clocks never come close.
    const timer = setTimeout(() => {
      this.timers.delete(gameId);
      this.onFire(gameId);
    }, delay);
    timer.unref();
    this.timers.set(gameId, timer);
  }

  clear(gameId: string): void {
    const t = this.timers.get(gameId);
    if (t) clearTimeout(t);
    this.timers.delete(gameId);
  }

  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}
