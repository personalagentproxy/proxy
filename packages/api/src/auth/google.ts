import {createHash, createHmac, randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';
import {Result} from 'ts-results-es';
import {z} from 'zod';

import {createOAuthAccount, getAccountByProvider} from '@proxy/db/auth';
import {createUserFromOAuthProfile, deleteUser, getUserByEmail, getUserFromId} from '@proxy/db/user';
import {formatFetchError, httpRequest, parseCookieHeader} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {establishSessionAndRedirect, queryParam, redirectToLoginError, sanitizeCallbackUrl, timingSafeEqualString, useSecureCookies} from './session';

/**
 * Google sign-in, an OAuth authorization-code flow with PKCE. A Google identity is an Account
 * row (provider 'google', providerAccountId = the profile's `sub`); an email that already
 * belongs to a user who signed up another way gets `OAuthAccountNotLinked` rather than being
 * attached silently.
 *
 * Both endpoints are top-level browser navigations (302 redirects), not fetch calls — CORS does
 * not apply and no CORS middleware is mounted.
 */

const googleAuthorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const googleTokenUrl = 'https://oauth2.googleapis.com/token';

const googleScope = 'openid email profile';

// The state cookie only has to survive the hop to Google and back.
const stateCookieMaxAgeSeconds = 15 * 60;

const stateCookieName = 'proxy.oauth-state';

// Scoped to /auth so it is only sent on the OAuth endpoints. Host-only on purpose: Google
// redirects straight back to this api origin, so the app origin never needs to see it.
const stateCookiePath = '/auth';

type OAuthConfig = {
	clientId: string;
	clientSecret: string;
	/** The app origin (where the user lands after sign-in). */
	appUrl: string;
	/** This api's callback URL — must be registered on the Google OAuth client. */
	redirectUri: string;
};

function getOAuthConfig(): OAuthConfig | null {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return null;
	}

	if (!env.APP_URL || !env.PROXY_API_PUBLIC_URL) {
		return null;
	}

	return {
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		appUrl: env.APP_URL,
		redirectUri: `${env.PROXY_API_PUBLIC_URL}/auth/google/callback`,
	};
}

const statePayloadSchema = z.object({
	state: z.string(),
	callbackUrl: z.string(),
	codeVerifier: z.string(),
});

type OAuthStatePayload = z.infer<typeof statePayloadSchema>;

// The state cookie is HMAC-signed so it can't be forged or transplanted from another browser's
// handshake: the callback only trusts a payload whose signature it can reproduce. The key is the
// OAuth client secret, a server-only value that is always set when this flow is configured.
function signStatePayload(body: string, key: string): string {
	return createHmac('sha256', key).update(body).digest('base64url');
}

function encodeStateCookie(payload: OAuthStatePayload, key: string): string {
	const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	return `${body}.${signStatePayload(body, key)}`;
}

function decodeStateCookie(value: string | undefined, key: string): OAuthStatePayload | null {
	if (!value) {
		return null;
	}

	const [body, signature] = value.split('.');
	if (!body || !signature || !timingSafeEqualString(signature, signStatePayload(body, key))) {
		return null;
	}

	return decodeJson(body, statePayloadSchema);
}

function readStateCookie(req: Request, key: string): OAuthStatePayload | null {
	if (!req.headers.cookie) {
		return null;
	}

	return decodeStateCookie(parseCookieHeader(req.headers.cookie).get(stateCookieName), key);
}

// Base64url JSON checked against a schema, or null when any step fails.
function decodeJson<T>(base64url: string, schema: z.ZodType<T>): T | null {
	const parsed = Result.wrap(() => JSON.parse(Buffer.from(base64url, 'base64url').toString('utf8')) as unknown);
	if (parsed.isErr()) {
		return null;
	}

	const validated = schema.safeParse(parsed.value);
	if (!validated.success) {
		return null;
	}

	return validated.data;
}

/**
 * `GET /auth/google?callbackUrl=...` — kicks off the handshake: stores state + PKCE verifier +
 * sanitized callbackUrl in a short-lived httpOnly cookie and 302s to Google's consent screen.
 */
export async function handleGoogleStartRoute(req: Request, res: Response): Promise<void> {
	const config = getOAuthConfig();
	if (!config) {
		log.error('Google OAuth start route called without complete OAuth configuration');
		if (!env.APP_URL) {
			res.status(500).json({error: 'oauth_not_configured'});
			return;
		}

		redirectToLoginError(res, env.APP_URL, 'OAuthSignin');
		return;
	}

	const callbackUrl = sanitizeCallbackUrl(queryParam(req, 'callbackUrl') ?? undefined) ?? '/';
	const state = randomBytes(16).toString('hex');
	const codeVerifier = randomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

	res.cookie(stateCookieName, encodeStateCookie({state, callbackUrl, codeVerifier}, config.clientSecret), {
		httpOnly: true,
		sameSite: 'lax',
		secure: useSecureCookies(),
		path: stateCookiePath,
		maxAge: stateCookieMaxAgeSeconds * 1000,
	});

	const url = new URL(googleAuthorizationUrl);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', googleScope);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	res.redirect(url.toString());
}

const googleTokensSchema = z.object({
	access_token: z.string().min(1),
	id_token: z.string().min(1),
	expires_in: z.number().optional(),
	refresh_token: z.string().optional(),
	scope: z.string().optional(),
	token_type: z.string().optional(),
});

/**
 * Direct server-to-server code exchange over TLS with Google's token endpoint. Because the
 * id_token comes straight from Google, its payload is trustworthy without an extra JWKS
 * signature check (the shortcut OpenID sanctions for the code flow).
 */
function exchangeCodeForTokens(config: OAuthConfig, code: string, codeVerifier: string) {
	return httpRequest(
		googleTokenUrl,
		{
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				redirect_uri: config.redirectUri,
				code_verifier: codeVerifier,
			}).toString(),
		},
		{schema: googleTokensSchema},
	);
}

const googleProfileSchema = z.object({
	sub: z.string().min(1),
	email: z.string().min(1),
	name: z.string().optional(),
	picture: z.string().optional(),
});

/** Decodes the id_token's payload — see `exchangeCodeForTokens` on why no JWKS check. */
function decodeIdTokenProfile(idToken: string) {
	const parts = idToken.split('.');
	const payloadPart = parts[1];
	if (parts.length !== 3 || !payloadPart) {
		return null;
	}

	return decodeJson(payloadPart, googleProfileSchema);
}

/**
 * `GET /auth/google/callback` — verifies state, exchanges the code, then:
 *
 * 1. Account row for (google, sub) exists → sign in as that user.
 * 2. No account but a user with the profile email exists → `OAuthAccountNotLinked`.
 * 3. Otherwise sign up: create the user and their Google account.
 */
export async function handleGoogleCallbackRoute(req: Request, res: Response): Promise<void> {
	const config = getOAuthConfig();
	if (!config) {
		log.error('Google OAuth callback route called without complete OAuth configuration');
		if (!env.APP_URL) {
			res.status(500).json({error: 'oauth_not_configured'});
			return;
		}

		redirectToLoginError(res, env.APP_URL, 'OAuthCallback');
		return;
	}

	const statePayload = readStateCookie(req, config.clientSecret);
	// State is single-use: clear it no matter how the callback resolves, with the attributes it
	// was set with — some browsers ignore a clear whose attributes don't match.
	res.clearCookie(stateCookieName, {
		httpOnly: true,
		sameSite: 'lax',
		secure: useSecureCookies(),
		path: stateCookiePath,
	});

	const providerError = queryParam(req, 'error');
	if (providerError) {
		log.warn('Google OAuth callback returned a provider error', {providerError});
		redirectToLoginError(res, config.appUrl, 'OAuthCallback');
		return;
	}

	const state = queryParam(req, 'state');
	const code = queryParam(req, 'code');
	if (!statePayload || !state || !code || !timingSafeEqualString(state, statePayload.state)) {
		log.warn('Google OAuth callback with missing or mismatched state');
		redirectToLoginError(res, config.appUrl, 'OAuthCallback');
		return;
	}

	// The signature already prevents tampering; sanitizing again keeps the open-redirect guard at
	// the point of use.
	const callbackUrl = sanitizeCallbackUrl(statePayload.callbackUrl) ?? '/';

	const tokensResult = await exchangeCodeForTokens(config, code, statePayload.codeVerifier);
	if (tokensResult.isErr()) {
		log.error('Google OAuth code exchange failed', {error: formatFetchError(tokensResult.error)});
		redirectToLoginError(res, config.appUrl, 'OAuthCallback');
		return;
	}

	const tokens = tokensResult.value;
	const profile = decodeIdTokenProfile(tokens.id_token);
	if (!profile) {
		log.error('Google OAuth id_token missing sub or email');
		redirectToLoginError(res, config.appUrl, 'OAuthCallback');
		return;
	}

	const accountResult = await getAccountByProvider('google', profile.sub);
	if (accountResult.isErr()) {
		log.error('Google OAuth account lookup failed', serializeError(accountResult.error));
		redirectToLoginError(res, config.appUrl, 'Callback');
		return;
	}

	if (accountResult.value) {
		// The stored Account tokens are not refreshed on repeat sign-ins.
		const userResult = await getUserFromId(accountResult.value.userId);
		if (userResult.isErr() || !userResult.value) {
			log.error('Google OAuth account points at a missing user', {userId: accountResult.value.userId});
			redirectToLoginError(res, config.appUrl, 'Callback');
			return;
		}

		await establishSessionAndRedirect(res, {appUrl: config.appUrl, callbackUrl, userId: userResult.value.id});
		return;
	}

	const existingByEmailResult = await getUserByEmail(profile.email);
	if (existingByEmailResult.isErr()) {
		log.error('Google OAuth user-by-email lookup failed', serializeError(existingByEmailResult.error));
		redirectToLoginError(res, config.appUrl, 'Callback');
		return;
	}

	if (existingByEmailResult.value) {
		redirectToLoginError(res, config.appUrl, 'OAuthAccountNotLinked');
		return;
	}

	const createdResult = await createUserFromOAuthProfile({
		email: profile.email,
		name: profile.name ?? null,
		image: profile.picture ?? null,
	});
	if (createdResult.isErr()) {
		log.error('Google OAuth user creation failed', serializeError(createdResult.error));
		redirectToLoginError(res, config.appUrl, 'OAuthCreateAccount');
		return;
	}

	const created = createdResult.value;
	const accountCreateResult = await createOAuthAccount({
		userId: created.id,
		type: 'oauth',
		provider: 'google',
		providerAccountId: profile.sub,
		access_token: tokens.access_token,
		refresh_token: tokens.refresh_token ?? null,
		expires_at: tokens.expires_in === undefined ? null : Math.floor(Date.now() / 1000) + tokens.expires_in,
		token_type: tokens.token_type ?? null,
		scope: tokens.scope ?? null,
		id_token: tokens.id_token,
	});
	if (accountCreateResult.isErr()) {
		log.error('Google OAuth account creation failed', serializeError(accountCreateResult.error));
		// Roll back the user: without its Account, the email would be locked out of Google sign-in
		// for good (OAuthAccountNotLinked).
		const rollbackResult = await deleteUser(created.id);
		if (rollbackResult.isErr()) {
			log.error('Google OAuth orphan user cleanup failed', serializeError(rollbackResult.error));
		}
		redirectToLoginError(res, config.appUrl, 'OAuthCreateAccount');
		return;
	}

	await establishSessionAndRedirect(res, {appUrl: config.appUrl, callbackUrl, userId: created.id});
}
