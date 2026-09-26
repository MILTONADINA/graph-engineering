import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { database } from '../config/database';
import { oauthAccountTable, refreshTokenTable } from '../config/schema';
import { getOAuthProvider, OAuthProviderConfig, OAuthProviderId, POST_LOGIN_REDIRECTS, redirectUriFor } from '../config/oauthProviders';
import { resolveAuthenticationIdentity } from './authIdentity';
import { createAccountForVerifiedEmail, findAccountByEmail } from './oauthAccountDirectory';
import { generateAccessToken, generateRefreshToken, isIdentityId, validIdentity } from '../utils/tokens';
import { SECRETS } from '../utils/helpers';

export const OAUTH_STATE_COOKIE = '__Host-graph_oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_HTTP_TIMEOUT_MS = 10 * 1000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
/** Lax so the provider's top-level redirect back carries it; Secure and __Host- so no other origin can plant it. */
export const oauthStateCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: OAUTH_STATE_TTL_MS };

/** Every failure surfaces as this one generic message; provider responses and secrets are never included or logged. */
export class OAuthLoginError extends Error {
  constructor() {
    super('OAuth sign-in failed');
    this.name = 'OAuthLoginError';
  }
}
function fail(): never {
  throw new OAuthLoginError();
}

export interface OAuthTransaction {
  provider: OAuthProviderId;
  /** 'login' signs in; 'link' attaches the provider to the account that started the flow while signed in. */
  intent: 'login' | 'link';
  /** The signed-in account for a 'link' transaction; empty for 'login'. */
  userId: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}
export interface OAuthProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

const base64url = (value: Buffer): string => value.toString('base64url');
const randomValue = (): string => base64url(randomBytes(32));
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT = /^[A-Za-z0-9._:@|-]{1,255}$/;

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}
/** Constant-time comparison independent of the inputs' lengths. */
export function safeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}
let stateKey: Buffer | undefined;
function transactionMac(body: string): string {
  stateKey ??= Buffer.from(hkdfSync('sha256', SECRETS.ACCESS_TOKEN_SECRET, 'graph-oauth-state', 'oauth-transaction-cookie-v1', 32));
  return base64url(createHmac('sha256', stateKey).update(body).digest());
}
export function sealTransaction(transaction: OAuthTransaction): string {
  const body = base64url(Buffer.from(JSON.stringify(transaction)));
  return `${body}.${transactionMac(body)}`;
}
export function openTransaction(value: unknown, now = Date.now()): OAuthTransaction | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], transactionMac(parts[0]))) return null;
  try {
    const item = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<OAuthTransaction>;
    if (!getOAuthProvider(item.provider) ||
      !((item.intent === 'login' && item.userId === '') || (item.intent === 'link' && isIdentityId(item.userId))) ||
      typeof item.state !== 'string' || !RANDOM_VALUE.test(item.state) ||
      typeof item.verifier !== 'string' || !RANDOM_VALUE.test(item.verifier) ||
      typeof item.nonce !== 'string' || (item.nonce !== '' && !RANDOM_VALUE.test(item.nonce)) ||
      typeof item.returnTo !== 'string' || !POST_LOGIN_REDIRECTS.includes(item.returnTo) ||
      typeof item.expiresAt !== 'number' || item.expiresAt <= now || item.expiresAt > now + OAUTH_STATE_TTL_MS) return null;
    return item as OAuthTransaction;
  } catch {
    return null;
  }
}
/** Only an exact allowlisted relative path is honored; anything else falls back to the first allowlisted path. */
export function allowedReturnTo(value: unknown): string {
  return typeof value === 'string' && POST_LOGIN_REDIRECTS.includes(value) ? value : POST_LOGIN_REDIRECTS[0];
}
/**
 * ASCII-only, checked before lower-casing: Unicode addresses, compatibility forms and case mappings that land on
 * ASCII (for example the Kelvin sign) are rejected rather than normalized into someone else's address.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 320 || !/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const email = trimmed.toLowerCase();
  return /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : null;
}

/** Authorization-code flow only (no implicit flow): state, PKCE S256 and, for OIDC, a nonce. */
function begin(providerId: unknown, returnTo: unknown, intent: 'login' | 'link', userId: string): { url: string; cookie: string } {
  const provider = getOAuthProvider(providerId);
  if (!provider || (intent === 'link' && !isIdentityId(userId))) fail();
  const transaction: OAuthTransaction = {
    provider: provider.id,
    intent,
    userId: intent === 'link' ? userId : '',
    state: randomValue(),
    nonce: provider.kind === 'oidc' ? randomValue() : '',
    verifier: randomValue(),
    returnTo: allowedReturnTo(returnTo),
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  };
  const url = new URL(provider.authorizationEndpoint);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUriFor(provider),
    scope: provider.scopes.join(' '),
    state: transaction.state,
    code_challenge: pkceChallenge(transaction.verifier),
    code_challenge_method: 'S256',
  });
  if (transaction.nonce) params.set('nonce', transaction.nonce);
  url.search = params.toString();
  return { url: url.toString(), cookie: sealTransaction(transaction) };
}
export function beginLogin(providerId: unknown, returnTo: unknown): { url: string; cookie: string } {
  return begin(providerId, returnTo, 'login', '');
}
/** Starts linking a provider to the signed-in account; the account id is sealed into the state cookie. */
export function beginLink(providerId: unknown, userId: string, returnTo: unknown): { url: string; cookie: string } {
  return begin(providerId, returnTo, 'link', userId);
}

async function requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') fail();
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS) });
  } catch {
    fail();
  }
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    fail();
  }
  const text = await readLimited(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail();
  }
}
/** Reads the body incrementally and stops as soon as it exceeds the limit, whatever content-length claims. */
async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail();
      }
      chunks.push(value);
    }
  } catch {
    fail();
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** Server-side exchange over HTTPS; the client secret travels only in the POST body. */
async function exchangeCode(provider: OAuthProviderConfig, code: string, verifier: string): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriFor(provider),
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: verifier,
  });
  const result = await requestJson(provider.tokenEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!result || typeof result !== 'object' || typeof (result as { access_token?: unknown }).access_token !== 'string') fail();
  return result as Record<string, unknown>;
}

/**
 * The ID token comes straight from the token endpoint over server-side TLS, so (OIDC Core 3.1.3.7)
 * TLS server validation stands in for signature verification; issuer, audience, expiry and nonce are still checked.
 */
export function verifyIdTokenClaims(provider: OAuthProviderConfig, idToken: unknown, nonce: string, now = Date.now()): OAuthProfile {
  if (provider.kind !== 'oidc' || typeof idToken !== 'string' || idToken.length > 8192) fail();
  const parts = idToken.split('.');
  if (parts.length !== 3) fail();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    fail();
  }
  if (!claims || typeof claims !== 'object') fail();
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== 'string' || !provider.issuers.includes(claims.iss) || !audiences.includes(provider.clientId) ||
    ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== provider.clientId) ||
    typeof claims.exp !== 'number' || claims.exp <= seconds || typeof claims.iat !== 'number' || claims.iat > seconds + 300 ||
    !nonce || !safeEqual(claims.nonce, nonce) || typeof claims.sub !== 'string' || !SUBJECT.test(claims.sub)) fail();
  const email = normalizeEmail(claims.email);
  return { subject: claims.sub, email, emailVerified: email !== null && claims.email_verified === true };
}
/** GitHub: only an email that is BOTH primary and verified counts. */
export function selectGithubEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  const chosen = emails.find((item: unknown) => {
    const entry = item as { primary?: unknown; verified?: unknown; email?: unknown } | null;
    return !!entry && typeof entry === 'object' && entry.primary === true && entry.verified === true && typeof entry.email === 'string';
  }) as { email: string } | undefined;
  return chosen ? normalizeEmail(chosen.email) : null;
}
async function githubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'graph-engineering-oauth',
    'x-github-api-version': '2022-11-28',
  };
  const user = (await requestJson('https://api.github.com/user', { headers })) as { id?: unknown } | null;
  if (!user || typeof user !== 'object' || !Number.isSafeInteger(user.id) || Number(user.id) <= 0) fail();
  const email = selectGithubEmail(await requestJson('https://api.github.com/user/emails', { headers }));
  return { subject: String(user.id), email, emailVerified: email !== null };
}

async function findLink(provider: OAuthProviderId, subject: string): Promise<string | null> {
  const [linked] = await database.select().from(oauthAccountTable)
    .where(and(eq(oauthAccountTable.provider, provider), eq(oauthAccountTable.providerSubject, subject))).limit(1);
  return linked ? linked.userId : null;
}
async function attach(provider: OAuthProviderId, profile: OAuthProfile & { email: string }, userId: string): Promise<string> {
  await database.insert(oauthAccountTable)
    .values({ userId, provider, providerSubject: profile.subject, email: profile.email })
    .onConflictDoNothing();
  // Re-read so a concurrent link, or an account already linked to a different subject of this provider, fails closed.
  if ((await findLink(provider, profile.subject)) !== userId) fail();
  return userId;
}
function verifiedProfile(profile: OAuthProfile): OAuthProfile & { email: string } {
  if (!profile.emailVerified || !profile.email || !SUBJECT.test(profile.subject)) fail();
  return profile as OAuthProfile & { email: string };
}

/**
 * Sign-in: an already-linked provider subject signs in to its account; an unused provider-verified email creates a
 * new account. A first-time provider login whose email already belongs to an account is refused by default, because
 * a weaker provider's "verified" email (a re-registered domain, a self-service IdP) must not take over that account.
 * The owner signs in the usual way and links the provider with beginLink. Only providers listed in
 * linkVerifiedEmailToExistingAccount restore automatic linking, and then only to an account whose own email is verified.
 */
export async function resolveLoginAccount(provider: OAuthProviderConfig, profile: OAuthProfile): Promise<string> {
  const verified = verifiedProfile(profile);
  const linked = await findLink(provider.id, verified.subject);
  if (linked) return linked;
  const existing = await findAccountByEmail(verified.email);
  if (existing) {
    if (!provider.linkVerifiedEmailToExistingAccount || existing.emailVerified !== true || !isIdentityId(existing.id)) fail();
    return attach(provider.id, verified, existing.id);
  }
  const created = await createAccountForVerifiedEmail(verified.email);
  if (!created || !isIdentityId(created.id)) fail();
  return attach(provider.id, verified, created.id);
}

/**
 * Explicit linking by a signed-in user. The provider-verified email must equal the account's email, the account must
 * still be active, and a provider subject already linked elsewhere is refused.
 */
export async function linkToAccount(provider: OAuthProviderConfig, profile: OAuthProfile, userId: string): Promise<string> {
  const verified = verifiedProfile(profile);
  const identity = await resolveAuthenticationIdentity(userId);
  if (!validIdentity(identity) || identity.id !== userId || identity.status !== 'active' ||
    normalizeEmail(identity.email) !== verified.email) fail();
  const linked = await findLink(provider.id, verified.subject);
  if (linked) {
    if (linked !== userId) fail();
    return userId;
  }
  return attach(provider.id, verified, userId);
}

/** Issues exactly the access/refresh token pair authentication.jwt defines. */
async function issueSession(userId: string): Promise<{ accessToken: string; refreshToken: string; refreshTokenExpiresAt: Date }> {
  const identity = await resolveAuthenticationIdentity(userId);
  if (!validIdentity(identity) || identity.id !== userId || identity.status !== 'active') fail();
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'graph-auth:' + identity.id}, 0))`);
    const refresh = generateRefreshToken();
    await tx.insert(refreshTokenTable).values({ userId: identity.id, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt });
    return {
      accessToken: generateAccessToken(identity.id, identity.role, identity.tenantId),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }, { isolationLevel: 'read committed' });
}

export type OAuthCallbackResult =
  | { kind: 'login'; accessToken: string; refreshToken: string; refreshTokenExpiresAt: Date; returnTo: string }
  | { kind: 'link'; returnTo: string };

/**
 * Identity comes only from the provider's token endpoint and APIs, never from request fields. The account to link
 * comes from the sealed state cookie set by the authenticated link request: the SameSite=Strict session cookies are
 * not sent on the provider's cross-site redirect back, so the callback cannot read req.user.
 */
export async function completeLogin(
  providerId: unknown,
  query: { code?: unknown; state?: unknown; error?: unknown },
  cookie: unknown,
): Promise<OAuthCallbackResult> {
  const transaction = openTransaction(cookie);
  const provider = getOAuthProvider(providerId);
  if (!transaction || !provider || transaction.provider !== provider.id || query.error !== undefined ||
    !safeEqual(query.state, transaction.state) || typeof query.code !== 'string' || query.code.length === 0 || query.code.length > 2048) fail();
  const tokens = await exchangeCode(provider, query.code, transaction.verifier);
  const profile = provider.kind === 'github'
    ? await githubProfile(String(tokens.access_token))
    : verifyIdTokenClaims(provider, tokens.id_token, transaction.nonce);
  const returnTo = allowedReturnTo(transaction.returnTo);
  if (transaction.intent === 'link') {
    await linkToAccount(provider, profile, transaction.userId);
    return { kind: 'link', returnTo };
  }
  const userId = await resolveLoginAccount(provider, profile);
  return { kind: 'login', ...(await issueSession(userId)), returnTo };
}
