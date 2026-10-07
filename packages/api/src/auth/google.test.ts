import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const createSession = mock();
const getAccountByProvider = mock();
const createOAuthAccount = mock();

mock.module('@proxy/db/auth', () => ({
	createSession,
	getAccountByProvider,
	createOAuthAccount,
}));

const getUserByEmail = mock();
const getUserFromId = mock();
const createUserFromOAuthProfile = mock();
const deleteUser = mock();

mock.module('@proxy/db/user', () => ({
	getUserByEmail,
	getUserFromId,
	createUserFromOAuthProfile,
	deleteUser,
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// Mutable so a test can unset the OAuth config; the routes read env per request.
const mockEnv: {
	NODE_ENV: string;
	APP_URL: string | undefined;
	GOOGLE_CLIENT_ID: string | undefined;
	GOOGLE_CLIENT_SECRET: string;
	ALLOWED_SIGNUP_EMAILS: string[] | undefined;
} = {
	NODE_ENV: 'production',
	ALLOWED_SIGNUP_EMAILS: undefined,
	APP_URL: 'https://app.example.com',
	GOOGLE_CLIENT_ID: 'google-client-id',
	GOOGLE_CLIENT_SECRET: 'google-client-secret',
};

mock.module('../utils/env', () => ({env: mockEnv}));

// The token exchange goes through httpRequest, which calls the global fetch.
const fetchMock = spyOn(globalThis, 'fetch');

async function importRoutes() {
	return import('./google');
}

type RecordedCookie = {name: string; value: string; options: Record<string, string | number | boolean | Date>};

function makeRes() {
	const cookies: RecordedCookie[] = [];
	const res = {
		cookies,
		redirect: mock(),
		cookie: mock((name: string, value: string, options: RecordedCookie['options']) => {
			cookies.push({name, value, options});
		}),
		clearCookie: mock(),
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

function makeIdToken(payload: Record<string, string | boolean>): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
	return `${encode({alg: 'RS256'})}.${encode(payload)}.signature`;
}

const googleProfile = {
	sub: 'google-sub-1',
	email: 'user@example.com',
	email_verified: true,
	name: 'Test User',
	picture: 'https://example.com/avatar.png',
};

// A Response body reads once, so each test sets a fresh one (every flow makes one exchange).
function mockTokenResponse(body: object, status = 200) {
	fetchMock.mockResolvedValue(new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}));
}

function mockTokenExchangeSuccess(idToken = makeIdToken(googleProfile)) {
	mockTokenResponse({
		access_token: 'access-token-1',
		id_token: idToken,
		expires_in: 3599,
		refresh_token: 'refresh-token-1',
		scope: 'openid email profile',
		token_type: 'Bearer',
	});
}

/**
 * Runs the start route for a real state cookie and redirect URL, then builds the callback request
 * the browser makes when Google redirects back: state from the URL, cookie from the jar.
 */
async function startFlow(callbackUrl = '/projects/abc') {
	const {handleGoogleStartRoute} = await importRoutes();
	const startRes = makeRes();
	await handleGoogleStartRoute({query: {callbackUrl}} as never, startRes as never);

	const stateCookie = startRes.cookies.find((cookie) => cookie.name === 'proxy.oauth-state');
	expect(stateCookie).toBeDefined();

	const redirectUrl = new URL(startRes.redirect.mock.calls[0]?.[0] as string);
	const state = redirectUrl.searchParams.get('state');
	expect(state).toBeTruthy();

	return {
		state: state as string,
		cookieHeader: `proxy.oauth-state=${stateCookie?.value}`,
		stateCookie,
		authorizationUrl: redirectUrl,
	};
}

function makeCallbackRequest(args: {state: string; cookieHeader: string; code?: string}) {
	return {
		query: {state: args.state, code: args.code ?? 'auth-code-1'},
		headers: {cookie: args.cookieHeader},
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.APP_URL = 'https://app.example.com';
	mockEnv.GOOGLE_CLIENT_ID = 'google-client-id';
	mockEnv.ALLOWED_SIGNUP_EMAILS = undefined;
	mockTokenExchangeSuccess();
	getAccountByProvider.mockResolvedValue(Ok(null));
	getUserByEmail.mockResolvedValue(Ok(null));
	getUserFromId.mockResolvedValue(Ok(null));
	createUserFromOAuthProfile.mockResolvedValue(Ok({id: 'user-new', email: googleProfile.email, name: googleProfile.name}));
	createOAuthAccount.mockResolvedValue(Ok(undefined));
	deleteUser.mockResolvedValue(Ok(undefined));
	createSession.mockResolvedValue(Ok(undefined));
});

describe('handleSignInMethodsRoute', () => {
	test('offers Google only when it is set up', async () => {
		const {handleSignInMethodsRoute} = await importRoutes();

		const configured = makeRes();
		handleSignInMethodsRoute({} as never, configured as never);
		expect(configured.json).toHaveBeenCalledWith({google: true});

		mockEnv.GOOGLE_CLIENT_ID = undefined;
		const unconfigured = makeRes();
		handleSignInMethodsRoute({} as never, unconfigured as never);
		expect(unconfigured.json).toHaveBeenCalledWith({google: false});
	});
});

describe('handleGoogleStartRoute', () => {
	test('redirects to Google with PKCE and stores state in a short-lived httpOnly cookie', async () => {
		const {authorizationUrl, stateCookie} = await startFlow();

		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(authorizationUrl.searchParams.get('client_id')).toBe('google-client-id');
		expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('https://app.example.com/auth/google/callback');
		expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
		expect(authorizationUrl.searchParams.get('scope')).toBe('openid email profile');
		expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();

		expect(stateCookie?.options).toEqual({
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			path: '/auth',
			maxAge: 15 * 60 * 1000,
		});
	});

	test('drops a callbackUrl that escapes the origin', async () => {
		getAccountByProvider.mockResolvedValue(Ok({userId: 'user-1'}));
		getUserFromId.mockResolvedValue(Ok({id: 'user-1', email: googleProfile.email, name: 'Test User'}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow('//evil.com');
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/');
	});

	test('without OAuth config → OAuthSignin error, or a 500 when APP_URL is unset too', async () => {
		mockEnv.GOOGLE_CLIENT_ID = undefined;

		const {handleGoogleStartRoute} = await importRoutes();
		const res = makeRes();
		await handleGoogleStartRoute({query: {}} as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthSignin');
		expect(res.cookies).toHaveLength(0);

		mockEnv.APP_URL = undefined;
		const bare = makeRes();
		await handleGoogleStartRoute({query: {}} as never, bare as never);

		expect(bare.status).toHaveBeenCalledWith(500);
		expect(bare.json).toHaveBeenCalledWith({error: 'oauth_not_configured'});
		expect(bare.redirect).not.toHaveBeenCalled();
	});
});

describe('handleGoogleCallbackRoute', () => {
	test('signs in an existing linked account: no user creation, session + cookie', async () => {
		getAccountByProvider.mockResolvedValue(Ok({userId: 'user-1'}));
		getUserFromId.mockResolvedValue(Ok({id: 'user-1', email: googleProfile.email, name: 'Existing User'}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(getAccountByProvider).toHaveBeenCalledWith('google', googleProfile.sub);
		expect(getUserFromId).toHaveBeenCalledWith('user-1');
		expect(createUserFromOAuthProfile).not.toHaveBeenCalled();
		expect(createOAuthAccount).not.toHaveBeenCalled();

		expect(createSession).toHaveBeenCalledTimes(1);
		const sessionArgs = createSession.mock.calls[0]?.[0] as {sessionToken: string; userId: string; expires: Date};
		expect(sessionArgs.userId).toBe('user-1');
		expect(sessionArgs.sessionToken).toMatch(/^[0-9a-f]{64}$/);

		// Prod naming under the mocked env.
		const sessionCookie = res.cookies.find((cookie) => cookie.name === '__Secure-proxy.session-token');
		expect(sessionCookie).toBeDefined();
		expect(sessionCookie?.value).toBe(sessionArgs.sessionToken);
		expect(sessionCookie?.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: true,
		});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');
	});

	test('signs up a new user: user + account created, redirect honored', async () => {
		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(createUserFromOAuthProfile).toHaveBeenCalledWith({
			email: googleProfile.email,
			name: googleProfile.name,
			image: googleProfile.picture,
		});
		expect(createOAuthAccount).toHaveBeenCalledWith({
			userId: 'user-new',
			type: 'oauth',
			provider: 'google',
			providerAccountId: googleProfile.sub,
			access_token: 'access-token-1',
			refresh_token: 'refresh-token-1',
			expires_at: expect.any(Number),
			token_type: 'Bearer',
			scope: 'openid email profile',
			id_token: expect.stringContaining('.'),
		});
		expect(createSession).toHaveBeenCalledTimes(1);
		expect((createSession.mock.calls[0]?.[0] as {userId: string}).userId).toBe('user-new');
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');

		// The token exchange used PKCE against Google's token endpoint.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [tokenUrl, init] = fetchMock.mock.calls[0] ?? [];
		expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
		const body = new URLSearchParams(init?.body as string);
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('auth-code-1');
		expect(body.get('code_verifier')).toBeTruthy();
	});

	test('a new user whose email Google has not verified → EmailNotVerified, no user, no session', async () => {
		mockTokenExchangeSuccess(makeIdToken({...googleProfile, email_verified: false}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=EmailNotVerified');
		expect(createUserFromOAuthProfile).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('a new user ALLOWED_SIGNUP_EMAILS leaves out → SignupNotAllowed, no user, no session', async () => {
		mockEnv.ALLOWED_SIGNUP_EMAILS = ['someone-else@example.com'];

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=SignupNotAllowed');
		expect(createUserFromOAuthProfile).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('a profile without name or picture signs up with nulls', async () => {
		mockTokenExchangeSuccess(makeIdToken({sub: googleProfile.sub, email: googleProfile.email, email_verified: true}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(createUserFromOAuthProfile).toHaveBeenCalledWith({email: googleProfile.email, name: null, image: null});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');
	});

	test('user creation failure → OAuthCreateAccount error, no account, no session', async () => {
		createUserFromOAuthProfile.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCreateAccount');
		expect(createOAuthAccount).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('account creation failure rolls back the new user, no session', async () => {
		createOAuthAccount.mockResolvedValue(Err(ApiErr.internalError(new Error('account insert failed'))));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		// Left behind, the user would lock its email out of Google sign-in (OAuthAccountNotLinked).
		expect(deleteUser).toHaveBeenCalledWith('user-new');
		expect(createSession).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCreateAccount');
	});

	test('existing user without a google account → OAuthAccountNotLinked, no session', async () => {
		getUserByEmail.mockResolvedValue(Ok({id: 'user-existing'}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(getUserByEmail).toHaveBeenCalledWith(googleProfile.email);
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthAccountNotLinked');
		expect(createUserFromOAuthProfile).not.toHaveBeenCalled();
		expect(createOAuthAccount).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('linked account pointing at a missing user → Callback error, no session', async () => {
		getAccountByProvider.mockResolvedValue(Ok({userId: 'user-gone'}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createUserFromOAuthProfile).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('mismatched state → OAuthCallback error, no token exchange, no session', async () => {
		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest({...flow, state: 'forged-state'}) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		// The clear must repeat the set attributes or some browsers keep the cookie.
		expect(res.clearCookie).toHaveBeenCalledWith('proxy.oauth-state', {
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			path: '/auth',
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('tampered state cookie (broken signature) → OAuthCallback error, no token exchange, no session', async () => {
		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		// Flip the last character so the HMAC no longer verifies.
		const tamperedHeader = flow.cookieHeader.slice(0, -1) + (flow.cookieHeader.endsWith('A') ? 'B' : 'A');

		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest({...flow, cookieHeader: tamperedHeader}) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('missing state cookie → OAuthCallback error, no token exchange', async () => {
		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute({query: {state: flow.state, code: 'auth-code-1'}, headers: {}} as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('provider error (consent denied) → OAuthCallback error, no token exchange', async () => {
		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute({query: {error: 'access_denied', state: flow.state}, headers: {cookie: flow.cookieHeader}} as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		expect(res.clearCookie).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('token exchange failure → OAuthCallback error, no session', async () => {
		mockTokenResponse({error: 'invalid_grant'}, 400);

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		expect(createSession).not.toHaveBeenCalled();
	});

	test('id_token without an email → OAuthCallback error, no lookup', async () => {
		mockTokenExchangeSuccess(makeIdToken({sub: googleProfile.sub}));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=OAuthCallback');
		expect(getAccountByProvider).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('db failure during the account lookup → Callback error, no session', async () => {
		getAccountByProvider.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleGoogleCallbackRoute} = await importRoutes();
		const flow = await startFlow();
		const res = makeRes();
		await handleGoogleCallbackRoute(makeCallbackRequest(flow) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createSession).not.toHaveBeenCalled();
	});
});
