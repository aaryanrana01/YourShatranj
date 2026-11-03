import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import { loginSchema, registerSchema } from '@chess/shared';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password.js';
import { REFRESH_TTL_SEC, type TokenService } from '../auth/tokens.js';
import type { RateLimiter } from '../security/rateLimit.js';
import type { UserRepo } from '../users.js';
import { HttpError, parse } from './errors.js';

export const REFRESH_COOKIE = 'rt';

export interface AuthedRequest extends Request {
  user?: { id: string; username: string };
}

/** Requires `Authorization: Bearer <access token>`. The user id comes only from the verified token. */
export function requireAuth(tokens: TokenService) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? tokens.verifyAccess(token) : null;
    if (!claims) throw new HttpError(401, 'UNAUTHORIZED', 'Please log in');
    req.user = { id: claims.sub, username: claims.name };
    next();
  };
}

export function authRouter(deps: {
  users: UserRepo;
  tokens: TokenService;
  limiter: RateLimiter;
  appOrigin: string;
  secureCookies: boolean;
}) {
  const { users, tokens, limiter, appOrigin, secureCookies } = deps;
  const router = Router();

  const cookieOptions: CookieOptions = {
    httpOnly: true, // JavaScript can't read it, so an XSS bug can't steal it
    secure: secureCookies, // HTTPS only in production
    sameSite: 'strict', // never sent on requests started by other sites (CSRF protection)
    path: '/api/auth', // only sent to the auth endpoints that need it
    maxAge: REFRESH_TTL_SEC * 1000,
  };

  /** Cookie-authenticated endpoints also check Origin: a second CSRF guard on top of SameSite. */
  const sameOrigin = (req: Request) => {
    const origin = req.headers.origin;
    if (origin && origin !== appOrigin) throw new HttpError(403, 'FORBIDDEN', 'Bad origin');
  };

  const session = async (res: Response, user: { id: string; username: string }, refresh: string) => {
    res.cookie(REFRESH_COOKIE, refresh, cookieOptions);
    res.json({ accessToken: tokens.signAccess(user.id, user.username), user });
  };

  router.post('/register', limiter.middleware('register', 5, 3600), async (req, res) => {
    const input = parse(registerSchema, req.body);
    const user = await users.create(input.username, await hashPassword(input.password));
    if (!user) throw new HttpError(409, 'CONFLICT', 'That username is taken');
    await session(res, user, await tokens.issueRefresh(user.id));
  });

  router.post('/login', limiter.middleware('login-ip', 30, 900), async (req, res) => {
    const input = parse(loginSchema, req.body);
    // Per-account limit too, so one account can't be brute-forced from many IPs.
    if (!(await limiter.hit('login-user', input.username.toLowerCase(), 10, 900))) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts for this account; wait 15 minutes');
    }
    const user = await users.findForLogin(input.username);
    const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);
    // Same message whether the user exists or not, so usernames can't be probed.
    if (!user || !ok) throw new HttpError(401, 'UNAUTHORIZED', 'Wrong username or password');
    if (user.isBanned) throw new HttpError(403, 'FORBIDDEN', 'This account is suspended');
    await session(res, { id: user.id, username: user.username }, await tokens.issueRefresh(user.id));
  });

  router.post('/refresh', limiter.middleware('refresh', 60, 60), async (req, res) => {
    sameOrigin(req);
    const current = req.cookies?.[REFRESH_COOKIE];
    if (typeof current !== 'string') throw new HttpError(401, 'UNAUTHORIZED', 'Not logged in');
    const rotated = await tokens.rotate(current);
    if (!rotated) {
      res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
      throw new HttpError(401, 'UNAUTHORIZED', 'Session expired, please log in again');
    }
    const user = await users.findById(rotated.userId);
    if (!user || user.isBanned) throw new HttpError(401, 'UNAUTHORIZED', 'Not logged in');
    await session(res, { id: user.id, username: user.username }, rotated.token);
  });

  router.post('/logout', async (req, res) => {
    sameOrigin(req);
    const current = req.cookies?.[REFRESH_COOKIE];
    if (typeof current === 'string') await tokens.revokeByToken(current);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  });

  return router;
}
