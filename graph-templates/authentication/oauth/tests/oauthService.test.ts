import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const db = vi.hoisted(() => {
  const state = { selects: [] as unknown[][], inserts: [] as unknown[] };
  const client = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.selects.shift() ?? [] }) }) }),
    insert: () => ({
      values: (value: unknown) => {
        state.inserts.push(value);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
    execute: async () => undefined,
  };
  return { state, database: { ...client, transaction: async (run: (tx: typeof client) => unknown) => run(client) } };
});
const directory = vi.hoisted(() => ({ findAccountByEmail: vi.fn(), createAccountForVerifiedEmail: vi.fn() }));
const identity = vi.hoisted(() => ({ resolveAuthenticationIdentity: vi.fn() }));
vi.mock('../src/config/database', () => ({ database: db.database }));
vi.mock('../src/services/oauthAccountDirectory', () => directory);
vi.mock('../src/services/authIdentity', () => identity);

import { getOAuthProvider, OAUTH_PROVIDERS, OAUTH_REDIRECT_URIS, OAuthProviderId, POST_LOGIN_REDIRECTS } from '../src/config/oauthProviders';
import {
  beginLink, beginLogin, completeLogin, linkToAccount, normalizeEmail, OAUTH_STATE_COOKIE, oauthStateCookieOptions,
  openTransaction, pkceChallenge, resolveLoginAccount, safeEqual, sealTransaction, selectGithubEmail, verifyIdTokenClaims,
} from '../src/services/oauthService';
import { oauthRoutes } from '../src/routes/oauthRoutes';
import { errorHandler } from '../src/middlewares/errorMiddleware';
import { SECRETS } from '../src/utils/helpers';
import { generateAccessToken, hashToken, verifyAccessToken } from '../src/utils/tokens';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const failure = /^OAuth sign-in failed$/;
const clearedState = `${OAUTH_STATE_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
const activeUser = { id: userId, email: 'person@example.com', role: 'customer', status: 'active' };
const verifiedProfile = { subject: 'subject-1', email: 'person@example.com', emailVerified: true };
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${segment({ alg: 'RS256' })}.${segment(claims)}.unchecked`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const oidc = OAUTH_PROVIDERS.filter((id) => getOAuthProvider(id)?.kind === 'oidc');
const provider = (id: OAuthProviderId) => getOAuthProvider(id)!;
const app = express();
app.use(cookieParser());
app.use('/api/auth', oauthRoutes);
app.use(errorHandler);
const setCookies = (response: { headers: Record<string, unknown> }) => (response.headers['set-cookie'] as string[] | undefined) ?? [];

function providerResponses(id: OAuthProviderId, nonce: string, verified: boolean, email = 'Person@Example.com') {
  const config = provider(id);
  const seconds = Math.floor(Date.now() / 1000);
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === config.tokenEndpoint)
      return json({
        access_token: 'provider-access',
        token_type: 'Bearer',
        ...(config.kind === 'oidc'
          ? { id_token: idToken({ iss: config.issuers[0], aud: config.clientId, sub: 'subject-1', email, email_verified: verified, nonce, iat: seconds, exp: seconds + 300 }) }
          : {}),
      });
    if (url === 'https://api.github.com/user') return json({ id: 4242 });
    if (url === 'https://api.github.com/user/emails')
      return json([{ email: 'other@example.com', primary: false, verified: true }, { email, primary: true, verified }]);
    return json({}, 404);
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  db.state.selects.length = 0;
  db.state.inserts.length = 0;
  directory.findAccountByEmail.mockReset();
  directory.createAccountForVerifiedEmail.mockReset();
  identity.resolveAuthenticationIdentity.mockReset();
});

describe('authentication.oauth service', () => {
  it('derives the S256 PKCE challenge from the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('starts an authorization-code flow with PKCE, state, an exact redirect URI and no client secret', () => {
    for (const id of OAUTH_PROVIDERS) {
      const config = provider(id);
      const { url, cookie } = beginLogin(id, '/');
      const target = new URL(url);
      const transaction = openTransaction(cookie)!;
      expect(target.protocol).toBe('https:');
      expect(target.searchParams.get('response_type')).toBe('code');
      expect(target.searchParams.get('code_challenge_method')).toBe('S256');
      expect(target.searchParams.get('code_challenge')).toBe(pkceChallenge(transaction.verifier));
      expect(target.searchParams.get('state')).toBe(transaction.state);
      expect(target.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URIS[id]);
      expect(OAUTH_REDIRECT_URIS[id]).toBe(`${new URL(process.env.OAUTH_REDIRECT_BASE_URL!).origin}/api/auth/oauth/${id}/callback`);
      expect(target.searchParams.has('client_secret')).toBe(false);
      expect(url).not.toContain(config.clientSecret);
      expect(cookie).not.toContain(config.clientSecret);
      expect(transaction).toMatchObject({ intent: 'login', userId: '' });
      expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (config.kind === 'oidc') expect(target.searchParams.get('nonce')).toBe(transaction.nonce);
      else expect(target.searchParams.has('nonce')).toBe(false);
    }
    expect(oauthStateCookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(oauthStateCookieOptions.maxAge).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(() => beginLogin('unknown', '/')).toThrow(failure);
    expect(() => beginLink(OAUTH_PROVIDERS[0], 'not-a-user', '/')).toThrow(failure);
  });

  it('keeps post-login redirects on allowlisted relative paths', () => {
    const id = OAUTH_PROVIDERS[0];
    for (const value of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/not-allowlisted', undefined, ['/']])
      expect(openTransaction(beginLogin(id, value).cookie)!.returnTo).toBe(POST_LOGIN_REDIRECTS[0]);
    for (const allowed of POST_LOGIN_REDIRECTS) expect(openTransaction(beginLogin(id, allowed).cookie)!.returnTo).toBe(allowed);
  });

  it('rejects missing, mismatched, forged or expired state before contacting the provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const id = OAUTH_PROVIDERS[0];
    const { cookie } = beginLogin(id, '/');
    const transaction = openTransaction(cookie)!;
    const forged = `${segment({ ...transaction, state: 'A'.repeat(43) })}.${cookie.split('.')[1]}`;
    const forgedLink = `${segment({ ...transaction, intent: 'link', userId })}.${cookie.split('.')[1]}`;
    expect(openTransaction(forged)).toBeNull();
    expect(openTransaction(forgedLink)).toBeNull();
    expect(openTransaction(sealTransaction({ ...transaction, expiresAt: Date.now() - 1 }))).toBeNull();
    expect(openTransaction(sealTransaction({ ...transaction, intent: 'link', userId: '' }))).toBeNull();
    expect(safeEqual(transaction.state, transaction.state)).toBe(true);
    expect(safeEqual(transaction.state, transaction.state.slice(1))).toBe(false);
    expect(safeEqual(undefined, transaction.state)).toBe(false);
    const attempts: [Record<string, unknown>, unknown][] = [
      [{ code: 'code' }, cookie],
      [{ code: 'code', state: 'A'.repeat(43) }, cookie],
      [{ code: 'code', state: transaction.state }, undefined],
      [{ code: 'code', state: 'A'.repeat(43) }, forged],
      [{ state: transaction.state }, cookie],
      [{ code: ['code'], state: transaction.state }, cookie],
      [{ code: 'code', state: transaction.state, error: 'access_denied' }, cookie],
    ];
    for (const [query, value] of attempts) await expect(completeLogin(id, query, value)).rejects.toThrow(failure);
    const other = OAUTH_PROVIDERS.find((item) => item !== id);
    if (other) await expect(completeLogin(other, { code: 'code', state: transaction.state }, cookie)).rejects.toThrow(failure);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exchanges the code server-side over HTTPS with the secret only in the POST body and a bounded timeout', async () => {
    for (const id of OAUTH_PROVIDERS) {
      const config = provider(id);
      const { cookie } = beginLogin(id, '/');
      const transaction = openTransaction(cookie)!;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ error: 'invalid_grant' }, 400));
      await expect(completeLogin(id, { code: 'authorization-code', state: transaction.state }, cookie)).rejects.toThrow(failure);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe(config.tokenEndpoint);
      expect(new URL(String(url)).protocol).toBe('https:');
      expect(String(url)).not.toContain(config.clientSecret);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_secret')).toBe(config.clientSecret);
      expect(form.get('code_verifier')).toBe(transaction.verifier);
      expect(form.get('redirect_uri')).toBe(OAUTH_REDIRECT_URIS[id]);
      fetchSpy.mockRestore();
    }
  });

  it('stops reading a provider response once it passes 64 KiB without a content-length', async () => {
    const id = OAUTH_PROVIDERS[0];
    const { cookie } = beginLogin(id, '/');
    const transaction = openTransaction(cookie)!;
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(endless, { status: 200 }));
    await expect(completeLogin(id, { code: 'code', state: transaction.state }, cookie)).rejects.toThrow(failure);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(7);
  });

  it('returns only a generic error when the provider is unreachable', async () => {
    const id = OAUTH_PROVIDERS[0];
    const { cookie } = beginLogin(id, '/');
    const transaction = openTransaction(cookie)!;
    const logged = vi.spyOn(console, 'error');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED internal-detail'));
    await expect(completeLogin(id, { code: 'code', state: transaction.state }, cookie)).rejects.toThrow(failure);
    expect(logged).not.toHaveBeenCalled();
  });

  it.runIf(oidc.length > 0)('checks OIDC ID token issuer, audience, expiry, nonce and email_verified', () => {
    const config = provider(oidc[0]);
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const nonce = 'N'.repeat(43);
    const valid = { iss: config.issuers[0], aud: config.clientId, sub: 'subject-1', email: 'Person@Example.com', email_verified: true, nonce, iat: seconds, exp: seconds + 300 };
    expect(verifyIdTokenClaims(config, idToken(valid), nonce, now)).toEqual(verifiedProfile);
    for (const flag of [false, 'true', undefined])
      expect(verifyIdTokenClaims(config, idToken({ ...valid, email_verified: flag }), nonce, now).emailVerified).toBe(false);
    for (const claims of [
      { ...valid, iss: 'https://evil.example' },
      { ...valid, aud: 'another-client' },
      { ...valid, aud: [config.clientId, 'another-client'] },
      { ...valid, exp: seconds - 1 },
      { ...valid, nonce: 'M'.repeat(43) },
      { ...valid, nonce: undefined },
      { ...valid, sub: '' },
    ])
      expect(() => verifyIdTokenClaims(config, idToken(claims), nonce, now)).toThrow(failure);
    expect(() => verifyIdTokenClaims(config, 'not-a-token', nonce, now)).toThrow(failure);
  });

  it('selects only an email that is both primary and verified from the GitHub emails API', () => {
    expect(selectGithubEmail([{ email: 'a@example.com', primary: true, verified: false }, { email: 'b@example.com', primary: false, verified: true }])).toBeNull();
    expect(selectGithubEmail([{ email: 'b@example.com', primary: false, verified: true }, { email: 'A@Example.com', primary: true, verified: true }])).toBe('a@example.com');
    expect(selectGithubEmail({ email: 'a@example.com', primary: true, verified: true })).toBeNull();
  });

  it('accepts only ASCII email addresses and checks them before lower-casing', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
    for (const value of ['pérson@example.com', 'person@exаmple.com', 'Kelvin@example.com', 'person＠example.com', 'per son@example.com', 'person@example', 42])
      expect(normalizeEmail(value)).toBeNull();
  });

  it('never creates or links an account for an unverified provider email', async () => {
    for (const id of OAUTH_PROVIDERS) {
      const { cookie } = beginLogin(id, '/');
      const transaction = openTransaction(cookie)!;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, false));
      await expect(completeLogin(id, { code: 'code', state: transaction.state }, cookie)).rejects.toThrow(failure);
      if (provider(id).kind === 'github') {
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain('https://api.github.com/user/emails');
        const headers = fetchSpy.mock.calls[1][1]?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer provider-access');
      }
      fetchSpy.mockRestore();
    }
    await expect(resolveLoginAccount(provider(OAUTH_PROVIDERS[0]), { ...verifiedProfile, emailVerified: false })).rejects.toThrow(failure);
    await expect(linkToAccount(provider(OAUTH_PROVIDERS[0]), { ...verifiedProfile, emailVerified: false }, userId)).rejects.toThrow(failure);
    expect(directory.findAccountByEmail).not.toHaveBeenCalled();
    expect(directory.createAccountForVerifiedEmail).not.toHaveBeenCalled();
    expect(db.state.inserts).toEqual([]);
  });

  it('refuses to attach a first-time provider login to an existing account unless the provider opts in', async () => {
    for (const id of OAUTH_PROVIDERS) {
      const config = provider(id);
      db.state.inserts.length = 0;
      directory.findAccountByEmail.mockResolvedValueOnce({ id: userId, emailVerified: true });
      if (!config.linkVerifiedEmailToExistingAccount) {
        await expect(resolveLoginAccount(config, verifiedProfile)).rejects.toThrow(failure);
        expect(db.state.inserts).toEqual([]);
      } else {
        db.state.selects.push([], [{ userId }]);
        expect(await resolveLoginAccount(config, verifiedProfile)).toBe(userId);
        expect(db.state.inserts).toEqual([{ userId, provider: id, providerSubject: 'subject-1', email: 'person@example.com' }]);
        db.state.inserts.length = 0;
        directory.findAccountByEmail.mockResolvedValueOnce({ id: userId, emailVerified: false });
        await expect(resolveLoginAccount(config, verifiedProfile)).rejects.toThrow(failure);
        expect(db.state.inserts).toEqual([]);
      }
    }
    expect(directory.createAccountForVerifiedEmail).not.toHaveBeenCalled();
  });

  it('signs in an already linked subject and creates a new account only for an unused verified email', async () => {
    const config = provider(OAUTH_PROVIDERS[0]);
    db.state.selects.push([{ userId }]);
    expect(await resolveLoginAccount(config, verifiedProfile)).toBe(userId);
    expect(directory.findAccountByEmail).not.toHaveBeenCalled();

    directory.findAccountByEmail.mockResolvedValueOnce(null);
    directory.createAccountForVerifiedEmail.mockResolvedValueOnce({ id: userId });
    db.state.selects.push([], [{ userId }]);
    expect(await resolveLoginAccount(config, verifiedProfile)).toBe(userId);
    expect(directory.createAccountForVerifiedEmail).toHaveBeenCalledWith('person@example.com');
    expect(db.state.inserts).toEqual([{ userId, provider: config.id, providerSubject: 'subject-1', email: 'person@example.com' }]);

    directory.findAccountByEmail.mockResolvedValueOnce(null);
    directory.createAccountForVerifiedEmail.mockResolvedValueOnce({ id: userId });
    db.state.selects.push([], []);
    await expect(resolveLoginAccount(config, verifiedProfile)).rejects.toThrow(failure);
  });

  it('links a provider to a signed-in account only when the verified email matches and the subject is unused', async () => {
    const config = provider(OAUTH_PROVIDERS[0]);
    identity.resolveAuthenticationIdentity.mockResolvedValue(activeUser);
    db.state.selects.push([], [{ userId }]);
    expect(await linkToAccount(config, verifiedProfile, userId)).toBe(userId);
    expect(db.state.inserts).toEqual([{ userId, provider: config.id, providerSubject: 'subject-1', email: 'person@example.com' }]);
    db.state.inserts.length = 0;

    await expect(linkToAccount(config, { ...verifiedProfile, email: 'someone-else@example.com' }, userId)).rejects.toThrow(failure);
    db.state.selects.push([{ userId: otherUserId }]);
    await expect(linkToAccount(config, verifiedProfile, userId)).rejects.toThrow(failure);
    identity.resolveAuthenticationIdentity.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });
    await expect(linkToAccount(config, verifiedProfile, userId)).rejects.toThrow(failure);
    expect(db.state.inserts).toEqual([]);
    expect(directory.findAccountByEmail).not.toHaveBeenCalled();
  });

  it('issues the authentication.jwt access and refresh tokens after a verified callback', async () => {
    for (const id of OAUTH_PROVIDERS) {
      db.state.inserts.length = 0;
      const { cookie } = beginLogin(id, POST_LOGIN_REDIRECTS[POST_LOGIN_REDIRECTS.length - 1]);
      const transaction = openTransaction(cookie)!;
      vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, true));
      directory.findAccountByEmail.mockResolvedValueOnce(null);
      directory.createAccountForVerifiedEmail.mockResolvedValueOnce({ id: userId });
      identity.resolveAuthenticationIdentity.mockResolvedValueOnce(activeUser);
      db.state.selects.push([], [{ userId }]);
      const result = await completeLogin(id, { code: 'code', state: transaction.state, email: 'attacker@example.com' } as never, cookie);
      if (result.kind !== 'login') throw new Error('expected a login result');
      expect(directory.createAccountForVerifiedEmail).toHaveBeenLastCalledWith('person@example.com');
      expect(verifyAccessToken(result.accessToken)?.sub).toBe(userId);
      expect(result.refreshToken).toMatch(/^[a-f0-9]{64}$/);
      expect(db.state.inserts).toContainEqual(expect.objectContaining({ userId, tokenHash: hashToken(result.refreshToken) }));
      expect(result.returnTo).toBe(POST_LOGIN_REDIRECTS[POST_LOGIN_REDIRECTS.length - 1]);
      vi.restoreAllMocks();
    }
    identity.resolveAuthenticationIdentity.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });
    const id = OAUTH_PROVIDERS[0];
    const { cookie } = beginLogin(id, '/');
    const transaction = openTransaction(cookie)!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, true));
    db.state.selects.push([{ userId }]);
    await expect(completeLogin(id, { code: 'code', state: transaction.state }, cookie)).rejects.toThrow(failure);
  });
});

describe('authentication.oauth routes', () => {
  const id = OAUTH_PROVIDERS[0];
  const callback = (state: string, cookie?: string) => {
    const call = request(app).get(`/api/auth/oauth/${id}/callback`).query({ code: 'code', state });
    return cookie ? call.set('Cookie', `${OAUTH_STATE_COOKIE}=${cookie}`) : call;
  };

  it('start sets a short-lived httpOnly Secure SameSite=Lax state cookie and redirects to the provider', async () => {
    const response = await request(app).get(`/api/auth/oauth/${id}/start`).query({ returnTo: '//evil.example' });
    expect(response.status).toBe(302);
    expect(response.headers.location.startsWith(provider(id).authorizationEndpoint)).toBe(true);
    const [state] = setCookies(response);
    expect(state).toMatch(new RegExp(`^${OAUTH_STATE_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Max-Age=600; Path=/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$`));
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/auth/oauth/unknown/start')).status).toBe(400);
  });

  it('callback success sets the auth cookies, clears the state cookie and 303-redirects to the allowlisted path', async () => {
    const { cookie } = beginLogin(id, POST_LOGIN_REDIRECTS[POST_LOGIN_REDIRECTS.length - 1]);
    const transaction = openTransaction(cookie)!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, true));
    directory.findAccountByEmail.mockResolvedValueOnce(null);
    directory.createAccountForVerifiedEmail.mockResolvedValueOnce({ id: userId });
    identity.resolveAuthenticationIdentity.mockResolvedValueOnce(activeUser);
    db.state.selects.push([], [{ userId }]);
    const response = await callback(transaction.state, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(POST_LOGIN_REDIRECTS[POST_LOGIN_REDIRECTS.length - 1]);
    const cookies = setCookies(response);
    expect(cookies).toContain(clearedState);
    const access = cookies.find((item) => item.startsWith('access_token='))!;
    expect(verifyAccessToken(decodeURIComponent(access.split(';')[0].slice('access_token='.length)))?.sub).toBe(userId);
    expect(access).toContain('HttpOnly');
    expect(cookies.some((item) => /^refresh_token=[a-f0-9]{64};/.test(item))).toBe(true);
  });

  it('rejected callback clears the state cookie and returns only the generic error', async () => {
    const { cookie } = beginLogin(id, '/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const response of [await callback('A'.repeat(43), cookie), await callback(openTransaction(cookie)!.state)]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: { message: 'OAuth sign-in failed', status: 401 } });
      const cookies = setCookies(response);
      expect(cookies).toEqual([clearedState]);
      expect(response.headers.location).toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('links a provider only for a signed-in trusted-origin request and never signs in through the link callback', async () => {
    identity.resolveAuthenticationIdentity.mockResolvedValue(activeUser);
    const link = () => request(app).post(`/api/auth/oauth/${id}/link`).query({ returnTo: '/' });
    const session = `access_token=${generateAccessToken(userId, 'customer')}`;
    for (const response of [await link().set('Origin', SECRETS.CORS_ORIGIN), await link().set('Origin', 'https://evil.example').set('Cookie', session)]) {
      expect([401, 403]).toContain(response.status);
      expect(setCookies(response)).toEqual([]);
    }
    const started = await link().set('Origin', SECRETS.CORS_ORIGIN).set('Cookie', session);
    expect(started.status).toBe(303);
    expect(started.headers.location.startsWith(provider(id).authorizationEndpoint)).toBe(true);
    const cookie = decodeURIComponent(setCookies(started)[0].split(';')[0].slice(OAUTH_STATE_COOKIE.length + 1));
    const transaction = openTransaction(cookie)!;
    expect(transaction).toMatchObject({ intent: 'link', userId });

    vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, true, 'someone-else@example.com'));
    const mismatch = await callback(transaction.state, cookie);
    expect(mismatch.status).toBe(401);
    expect(db.state.inserts).toEqual([]);

    vi.spyOn(globalThis, 'fetch').mockImplementation(providerResponses(id, transaction.nonce, true));
    db.state.selects.push([], [{ userId }]);
    const linked = await callback(transaction.state, cookie);
    expect(linked.status).toBe(303);
    expect(linked.headers.location).toBe('/');
    expect(setCookies(linked)).toEqual([clearedState]);
    expect(db.state.inserts).toEqual([{ userId, provider: id, providerSubject: 'subject-1', email: 'person@example.com' }]);
    expect(directory.findAccountByEmail).not.toHaveBeenCalled();
  });
});
