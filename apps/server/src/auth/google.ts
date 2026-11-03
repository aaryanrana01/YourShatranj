import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Who Google says signed in. `sub` is Google's permanent id for the account. */
export interface GoogleIdentity {
  sub: string;
  /** Used only to suggest a username; never stored. */
  name: string | null;
}

/** The two things the sign-in flow needs from Google. Tests swap in a fake. */
export interface GoogleProvider {
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): string;
  /** Trades the one-time code for a signed ID token, checks it, and returns the identity. */
  exchange(p: { code: string; redirectUri: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Google's public signing keys. jose caches them and refetches when Google rotates keys.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export class GoogleOAuth implements GoogleProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizationUrl({ redirectUri, state, nonce, codeChallenge }: Parameters<GoogleProvider['authorizationUrl']>[0]) {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // openid + profile: Google's account id and display name. No email, no contacts, nothing else.
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // Lets people with several Google accounts pick one instead of silently using the last.
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async exchange({ code, redirectUri, codeVerifier, nonce }: Parameters<GoogleProvider['exchange']>[0]) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
    const body = (await res.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string') throw new Error('Google returned no ID token');

    // Signature, issuer, audience (this app's client id) and expiry are all checked here.
    const { payload } = await jwtVerify(body.id_token, JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: this.clientId,
    });
    // The nonce ties this token to the sign-in we started, so an old token can't be replayed.
    if (payload.nonce !== nonce) throw new Error('Google ID token nonce mismatch');
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Google ID token has no subject');
    const name = typeof payload.given_name === 'string' ? payload.given_name : typeof payload.name === 'string' ? payload.name : null;
    return { sub: payload.sub, name };
  }
}

/** PKCE: a random secret we keep, and its hash that goes to Google. Stops stolen codes from being used. */
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const randomToken = () => randomBytes(24).toString('base64url');

/** Turns a display name into a valid username suggestion (letters, digits, _ and -, 3–20 characters). */
export function suggestUsername(name: string | null): string {
  const cleaned = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // é → e
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16);
  return cleaned.length >= 3 ? cleaned : 'player';
}
