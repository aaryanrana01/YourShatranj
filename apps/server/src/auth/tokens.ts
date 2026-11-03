import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { refreshTokens } from '../db/schema.js';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
/** Two tabs refreshing at the same moment both present the same token; allow that briefly. */
const CONCURRENT_REFRESH_GRACE_MS = 10_000;

export interface AccessClaims {
  sub: string;
  name: string;
}

/**
 * Two kinds of token:
 *  - Access token: short-lived JWT, kept in the browser's memory (never in
 *    localStorage, where injected scripts could read it), sent as a header.
 *  - Refresh token: long-lived random string in an httpOnly cookie that
 *    JavaScript can't read. Rotated on every use; reusing an old one revokes
 *    the whole login (it means the token was copied).
 */
export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly accessSecret: string,
    private readonly refreshSecret: string,
  ) {}

  signAccess(userId: string, username: string): string {
    const claims: AccessClaims = { sub: userId, name: username };
    return jwt.sign(claims, this.accessSecret, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SEC });
  }

  verifyAccess(token: string): AccessClaims | null {
    try {
      // Pinning the algorithm blocks "alg: none" and algorithm-confusion attacks.
      const decoded = jwt.verify(token, this.accessSecret, { algorithms: ['HS256'] });
      if (typeof decoded !== 'object' || typeof decoded.sub !== 'string' || typeof decoded.name !== 'string') {
        return null;
      }
      return { sub: decoded.sub, name: decoded.name };
    } catch {
      return null;
    }
  }

  /** HMAC with a server secret: even a full database leak can't turn stored hashes into usable tokens. */
  private hash(token: string): string {
    return createHmac('sha256', this.refreshSecret).update(token).digest('hex');
  }

  async issueRefresh(userId: string, familyId: string = randomUUID()): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: this.hash(token),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
    });
    return token;
  }

  /**
   * Rotates a refresh token. Returns the user id and a new token, or null if
   * the token is invalid, expired, or a replay of an already-used token
   * (in which case the whole family is revoked).
   */
  async rotate(token: string): Promise<{ userId: string; token: string } | null> {
    const tokenHash = this.hash(token);
    const now = new Date();

    // Atomically mark it used; only one concurrent request can win this update.
    const [claimed] = await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, now)))
      .returning();
    if (claimed) {
      return { userId: claimed.userId, token: await this.issueRefresh(claimed.userId, claimed.familyId) };
    }

    const [existing] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    if (!existing || existing.expiresAt <= now) return null;
    if (existing.revokedAt && now.getTime() - existing.revokedAt.getTime() < CONCURRENT_REFRESH_GRACE_MS) {
      // Benign race (two tabs). Issue another token in the same family.
      const familyAlive = await this.db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)))
        .limit(1);
      if (familyAlive.length > 0) {
        return { userId: existing.userId, token: await this.issueRefresh(existing.userId, existing.familyId) };
      }
      return null;
    }
    // Replay of an old token: assume theft and log out every session of this login.
    await this.revokeFamily(existing.familyId);
    return null;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeByToken(token: string): Promise<void> {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, this.hash(token)));
    if (row) await this.revokeFamily(row.familyId);
  }
}
