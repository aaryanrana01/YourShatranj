import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleProvider } from '../src/auth/google.js';
import { suggestUsername } from '../src/auth/google.js';
import { createLogger } from '../src/logger.js';
import { buildServer } from '../src/server.js';
import { ORIGIN, http, register, testConfig, uniqueName } from './helpers.js';

/**
 * A stand-in for Google: codes look like "ok:<google id>:<name>". It also
 * checks that the server sent the PKCE verifier and nonce that match what it
 * put in the authorization URL, exactly as real Google would.
 */
class FakeGoogle implements GoogleProvider {
  lastChallenge = '';
  lastNonce = '';
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }) {
    this.lastChallenge = p.codeChallenge;
    this.lastNonce = p.nonce;
    const url = new URL('https://accounts.example/auth');
    url.search = new URLSearchParams({ state: p.state, redirect_uri: p.redirectUri }).toString();
    return url.toString();
  }
  async exchange(p: { code: string; redirectUri: string; codeVerifier: string; nonce: string }) {
    const challenge = createHash('sha256').update(p.codeVerifier).digest('base64url');
    if (challenge !== this.lastChallenge) throw new Error('PKCE mismatch');
    if (p.nonce !== this.lastNonce) throw new Error('nonce mismatch');
    const [kind, sub, name] = p.code.split(':');
    if (kind !== 'ok' || !sub) throw new Error('bad code');
    return { sub, name: name ?? null };
  }
}

type Server = Awaited<ReturnType<typeof buildServer>>;
let server: Server;
let base: string;

/** Collects Set-Cookie headers into a "Cookie" request header, like a browser would. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: { headers: Headers }) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  has(name: string) {
    return this.cookies.has(name);
  }
}

async function get(path: string, jar: Jar) {
  const res = await fetch(base + path, { redirect: 'manual', headers: { Cookie: jar.header() } });
  jar.take(res);
  return res;
}

/** Steps 1–2: start sign-in, "come back from Google" with the given code. Returns where we were sent. */
async function signIn(jar: Jar, code: string, tamperState = false) {
  const start = await get('/api/auth/google', jar);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const sentState = tamperState ? `${state}x` : state;
  const back = await get(`/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${sentState}`, jar);
  expect(back.status).toBe(302);
  return back.headers.get('location');
}

async function complete(jar: Jar, username: string, origin = ORIGIN) {
  const res = await fetch(`${base}/api/auth/google/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: jar.header() },
    body: JSON.stringify({ username }),
  });
  jar.take(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  server = await buildServer(testConfig(), createLogger('silent', false), { google: new FakeGoogle() });
  await server.redis.flushdb();
  base = `http://127.0.0.1:${await server.start(0)}`;
});

beforeEach(async () => {
  const keys = await server.redis.keys('rl:*');
  if (keys.length) await server.redis.del(...keys);
});

afterAll(async () => {
  await server?.stop();
});

describe('Continue with Google', () => {
  it('tells the site the Google button is available', async () => {
    const res = await http(base, '/api/auth/providers');
    expect(res.body).toEqual({ google: true });
  });

  it('sends the browser to Google with a state cookie that is Lax, httpOnly and short-lived', async () => {
    const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fauth%2Fgoogle%2Fcallback');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('g_state='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it('signs up a new Google user: pick a username, then log in', async () => {
    const jar = new Jar();
    const sub = uniqueName('g');
    expect(await signIn(jar, `ok:${sub}:Aaryan`)).toBe('/welcome');
    expect(jar.has('g_state')).toBe(false); // one use only
    expect(jar.has('rt')).toBe(false); // not logged in until a username is chosen

    const pending = await get('/api/auth/google/pending', jar);
    expect(pending.status).toBe(200);
    expect((await pending.json()).suggestion).toMatch(/^Aaryan\d*$/);

    const username = uniqueName('gu');
    const done = await complete(jar, username);
    expect(done.status).toBe(200);
    expect(done.body.user.username).toBe(username);
    expect(typeof done.body.accessToken).toBe('string');
    expect(jar.has('rt')).toBe(true);
    expect(jar.has('g_pending')).toBe(false);

    // The refresh cookie restores the session, as it does after a page load.
    const refreshed = await fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: jar.header() } });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).user.username).toBe(username);

    // Next time, the same Google account goes straight in.
    const again = new Jar();
    expect(await signIn(again, `ok:${sub}:Aaryan`)).toBe('/');
    expect(again.has('rt')).toBe(true);
  });

  it('refuses a username that is taken and lets the user try another', async () => {
    const taken = await register(base, uniqueName('own'));
    const jar = new Jar();
    expect(await signIn(jar, `ok:${uniqueName('g')}:Someone`)).toBe('/welcome');
    const clash = await complete(jar, taken.user.username.toUpperCase());
    expect(clash.status).toBe(409);
    const ok = await complete(jar, uniqueName('free'));
    expect(ok.status).toBe(200);
  });

  it('rejects a callback whose state does not match (login CSRF)', async () => {
    const jar = new Jar();
    expect(await signIn(jar, `ok:${uniqueName('g')}:X`, true)).toBe('/login?error=google');
    expect(jar.has('rt')).toBe(false);
    expect(jar.has('g_pending')).toBe(false);
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await fetch(`${base}/api/auth/google/callback?code=ok:abc:X&state=whatever`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/login?error=google');
  });

  it('handles Google errors and the user pressing Cancel', async () => {
    const jar = new Jar();
    expect(await signIn(jar, 'bad-code')).toBe('/login?error=google');
    await get('/api/auth/google', jar);
    const cancelled = await get('/api/auth/google/callback?error=access_denied', jar);
    expect(cancelled.headers.get('location')).toBe('/login?error=google');
  });

  it('cannot finish a sign-up without the pending cookie, or from another site', async () => {
    expect((await complete(new Jar(), uniqueName('nope'))).status).toBe(401);
    expect((await get('/api/auth/google/pending', new Jar())).status).toBe(404);

    const jar = new Jar();
    await signIn(jar, `ok:${uniqueName('g')}:X`);
    expect((await complete(jar, uniqueName('evil'), 'https://evil.example')).status).toBe(403);
  });

  it('a Google-only account has no password that could be guessed', async () => {
    const jar = new Jar();
    await signIn(jar, `ok:${uniqueName('g')}:X`);
    const username = uniqueName('nopw');
    expect((await complete(jar, username)).status).toBe(200);
    const login = await http(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: 'anything-at-all' }) });
    expect(login.status).toBe(401);
  });
});

describe('username suggestions', () => {
  it('turns Google names into valid usernames', () => {
    expect(suggestUsername('Aaryan')).toBe('Aaryan');
    expect(suggestUsername('José María')).toBe('JoseMaria');
    expect(suggestUsername('李')).toBe('player');
    expect(suggestUsername(null)).toBe('player');
    expect(suggestUsername('A very long display name indeed')).toHaveLength(16);
  });
});
