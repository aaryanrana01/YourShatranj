import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { googleCompleteSchema } from '@chess/shared';
import { type GoogleProvider, pkcePair, randomToken, suggestUsername } from '../auth/google.js';
import type { TokenService } from '../auth/tokens.js';
import type { Logger } from '../logger.js';
import type { RateLimiter } from '../security/rateLimit.js';
import type { UserRepo } from '../users.js';
import { HttpError, parse } from './errors.js';
import { REFRESH_COOKIE, refreshCookieOptions } from './auth.js';

const STATE_COOKIE = 'g_state';
const PENDING_COOKIE = 'g_pending';
const STATE_TTL_SEC = 10 * 60;
const PENDING_TTL_SEC = 15 * 60;

interface StateClaims {
  state: string;
  nonce: string;
  verifier: string;
}
interface PendingClaims {
  gsub: string;
  suggestion: string;
}

/**
 * "Continue with Google" (OpenID Connect, authorization-code flow).
 *
 *  1. GET /api/auth/google            → we make a random state, nonce and PKCE secret,
 *                                        keep them in a short-lived signed cookie, and
 *                                        send the browser to Google.
 *  2. GET /api/auth/google/callback   → Google sends the browser back with a one-time
 *                                        code. We check the state, trade the code for a
 *                                        signed ID token, and verify it.
 *       - known Google account → logged in, back to the home page
 *       - new Google account   → to /welcome to pick a username
 *  3. POST /api/auth/google/complete  → creates the account with that username.
 */
export function googleRouter(deps: {
  provider: GoogleProvider;
  users: UserRepo;
  tokens: TokenService;
  limiter: RateLimiter;
  appOrigin: string;
  secureCookies: boolean;
  /** Our own secret; a separate key is derived from it so these cookies can never pass as access tokens. */
  secret: string;
  log: Logger;
}) {
  const { provider, users, tokens, limiter, appOrigin, secureCookies, log } = deps;
  const router = Router();
  const key = createHmac('sha256', deps.secret).update('google-oauth-cookies-v1').digest();
  const redirectUri = `${appOrigin}/api/auth/google/callback`;

  // Lax, not Strict: the browser must send it when Google redirects back (a navigation from google.com).
  const stateCookie: CookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/api/auth/google',
    maxAge: STATE_TTL_SEC * 1000,
  };
  const pendingCookie: CookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict',
    path: '/api/auth/google',
    maxAge: PENDING_TTL_SEC * 1000,
  };

  const sign = (claims: object, audience: string, ttl: number) =>
    jwt.sign(claims, key, { algorithm: 'HS256', audience, expiresIn: ttl });

  function read<T>(token: unknown, audience: string): T | null {
    if (typeof token !== 'string') return null;
    try {
      return jwt.verify(token, key, { algorithms: ['HS256'], audience }) as T;
    } catch {
      return null;
    }
  }

  const sameString = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  const sameOrigin = (req: Request) => {
    const origin = req.headers.origin;
    if (origin && origin !== appOrigin) throw new HttpError(403, 'FORBIDDEN', 'Bad origin');
  };

  /** Logs the user in by setting the refresh cookie; the page then restores the session from it. */
  async function startSession(res: Response, userId: string) {
    res.cookie(REFRESH_COOKIE, await tokens.issueRefresh(userId), refreshCookieOptions(secureCookies));
  }

  /** A free username based on the Google name, e.g. "Aaryan" or "Aaryan482". */
  async function freeUsername(name: string | null): Promise<string> {
    const base = suggestUsername(name);
    if (!(await users.isUsernameTaken(base))) return base;
    for (let i = 0; i < 5; i++) {
      const candidate = `${base}${Math.floor(100 + Math.random() * 9900)}`;
      if (!(await users.isUsernameTaken(candidate))) return candidate;
    }
    return base;
  }

  router.get('/', limiter.middleware('google-start', 20, 600), (_req, res) => {
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    res.cookie(STATE_COOKIE, sign({ state, nonce, verifier } satisfies StateClaims, 'google-state', STATE_TTL_SEC), stateCookie);
    res.redirect(provider.authorizationUrl({ redirectUri, state, nonce, codeChallenge: challenge }));
  });

  router.get('/callback', limiter.middleware('google-callback', 20, 600), async (req, res) => {
    const saved = read<StateClaims>(req.cookies?.[STATE_COOKIE], 'google-state');
    // One use only: clear it whatever happens next.
    res.clearCookie(STATE_COOKIE, { ...stateCookie, maxAge: undefined });
    const fail = (reason: string, err?: unknown) => {
      log.warn({ reason, err }, 'google sign-in failed');
      res.redirect('/login?error=google');
    };

    const { code, state, error } = req.query;
    if (typeof error === 'string') return fail(`google returned ${error.slice(0, 40)}`); // e.g. the user pressed Cancel
    if (!saved) return fail('missing or expired state cookie');
    if (typeof state !== 'string' || !sameString(state, saved.state)) return fail('state mismatch');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2048) return fail('missing code');

    let identity;
    try {
      identity = await provider.exchange({ code, redirectUri, codeVerifier: saved.verifier, nonce: saved.nonce });
    } catch (err) {
      return fail('token exchange or verification failed', err);
    }

    const existing = await users.findByGoogleSub(identity.sub);
    if (existing) {
      if (existing.isBanned) return res.redirect('/login?error=suspended');
      await startSession(res, existing.id);
      return res.redirect('/');
    }

    const pending: PendingClaims = { gsub: identity.sub, suggestion: await freeUsername(identity.name) };
    res.cookie(PENDING_COOKIE, sign(pending, 'google-pending', PENDING_TTL_SEC), pendingCookie);
    res.redirect('/welcome');
  });

  /** The /welcome page asks this for the suggested username (and whether a sign-up is in progress at all). */
  router.get('/pending', (req, res) => {
    const pending = read<PendingClaims>(req.cookies?.[PENDING_COOKIE], 'google-pending');
    if (!pending) throw new HttpError(404, 'NOT_FOUND', 'No Google sign-up in progress');
    res.json({ suggestion: pending.suggestion });
  });

  router.post('/complete', limiter.middleware('google-complete', 20, 3600), async (req, res) => {
    sameOrigin(req);
    const pending = read<PendingClaims>(req.cookies?.[PENDING_COOKIE], 'google-pending');
    if (!pending) throw new HttpError(401, 'UNAUTHORIZED', 'Your Google sign-in expired. Please try again.');
    const { username } = parse(googleCompleteSchema, req.body);

    const created = await users.createWithGoogle(username, pending.gsub);
    if (created === 'username_taken') throw new HttpError(409, 'CONFLICT', 'That username is taken');

    const user = created === 'already_linked' ? await users.findByGoogleSub(pending.gsub) : created;
    if (!user) throw new HttpError(500, 'INTERNAL', 'Could not create the account');
    res.clearCookie(PENDING_COOKIE, { ...pendingCookie, maxAge: undefined });
    await startSession(res, user.id);
    res.json({ accessToken: tokens.signAccess(user.id, user.username), user: { id: user.id, username: user.username } });
  });

  return router;
}
