/** If the side to move hasn't made their first move by then, the game is aborted (no rating change). */
export const FIRST_MOVE_TIMEOUT_MS = 30_000;

/** How long a player may be disconnected before the opponent can claim the win. */
export const DISCONNECT_GRACE_MS = 60_000;

/**
 * Most network delay credited back per move. Without a cap, a player could
 * fake huge lag to gain time; with it, slow mobile data isn't punished.
 */
export const MAX_LAG_CREDIT_MS = 300;

export const MAX_DRAW_OFFERS_PER_PLAYER = 3;

/** Draw-offer/disconnect bookkeeping isn't needed once a game is persisted; keep it 24 h for review links. */
export const ENDED_GAME_TTL_SEC = 24 * 60 * 60;

/** Hard cap on game length so a game record can't grow forever. */
export const MAX_PLY = 1000;
