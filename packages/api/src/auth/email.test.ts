import {createHash} from 'node:crypto';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const createSession = mock();
const createVerificationToken = mock();
const useVerificationToken = mock();

mock.module('@proxy/db/auth', () => ({
	createSession,
	createVerificationToken,
	useVerificationToken,
}));

const getUserByEmail = mock();
const createUserFromEmail = mock();
const setUserEmailVerified = mock();

mock.module('@proxy/db/user', () => ({
	getUserByEmail,
	createUserFromEmail,
	setUserEmailVerified,
}));

const sendMagicLink = mock();

mock.module('./mail', () => ({
	sendMagicLink,
}));

const logInfo = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: logInfo, warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// Mutable so tests can flip values; the routes read env per request.
const mockEnv: {
	NODE_ENV: string;
	APP_URL: string | undefined;
	AUTH_SECRET: string | undefined;
	RESEND_KEY: string | undefined;
	ALLOWED_SIGNUP_EMAILS: string[] | undefined;
} = {
	NODE_ENV: 'production',
	RESEND_KEY: 're_test',
	ALLOWED_SIGNUP_EMAILS: undefined,
	APP_URL: 'https://app.example.com',
	AUTH_SECRET: 'test-secret',
};

mock.module('../utils/env', () => ({env: mockEnv}));

async function importRoutes() {
	return import('./email');
}

/** sha256(rawToken + secret), hex. */
function hashToken(token: string): string {
	return createHash('sha256').update(`${token}${mockEnv.AUTH_SECRET}`).digest('hex');
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
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

/** Runs the send route and returns the mailed verify URL and its query, which the verify route later receives. */
async function sendFlow(args?: {email?: string; callbackUrl?: string}) {
	const {handleEmailSignInRoute} = await importRoutes();
	const res = makeRes();
	await handleEmailSignInRoute({body: {email: args?.email ?? 'user@example.com', callbackUrl: args?.callbackUrl ?? '/projects/abc'}} as never, res as never);

	expect(sendMagicLink).toHaveBeenCalledTimes(1);
	const url = new URL((sendMagicLink.mock.calls[0]?.[0] as {url: string}).url);

	return {
		res,
		url,
		query: {
			token: url.searchParams.get('token') as string,
			email: url.searchParams.get('email') as string,
			callbackUrl: url.searchParams.get('callbackUrl') as string,
		},
	};
}

function makeVerifyRequest(query: Record<string, string>) {
	return {query};
}

const storedRow = () => createVerificationToken.mock.calls[0]?.[0] as {identifier: string; token: string; expires: Date};

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.NODE_ENV = 'production';
	mockEnv.APP_URL = 'https://app.example.com';
	mockEnv.AUTH_SECRET = 'test-secret';
	mockEnv.RESEND_KEY = 're_test';
	mockEnv.ALLOWED_SIGNUP_EMAILS = undefined;
	createVerificationToken.mockResolvedValue(Ok(undefined));
	useVerificationToken.mockResolvedValue(Ok(null));
	sendMagicLink.mockResolvedValue(Ok(undefined));
	getUserByEmail.mockResolvedValue(Ok(null));
	createUserFromEmail.mockResolvedValue(Ok({id: 'user-new', email: 'user@example.com', name: null}));
	setUserEmailVerified.mockResolvedValue(Ok({id: 'user-1', email: 'user@example.com', name: 'Existing User'}));
	createSession.mockResolvedValue(Ok(undefined));
});

describe('handleEmailSignInRoute', () => {
	test('stores a hashed token row (24h expiry) and mails a verify URL on the app origin', async () => {
		const before = Date.now();
		const {res, url, query} = await sendFlow();

		// The mailed link targets the api's verify endpoint with the raw token.
		expect(url.origin + url.pathname).toBe('https://app.example.com/auth/email/verify');
		expect(query.email).toBe('user@example.com');
		expect(query.callbackUrl).toBe('/projects/abc');
		expect(query.token).toMatch(/^[0-9a-f]{64}$/);

		// The row stores the hash of that token, never the raw value.
		expect(createVerificationToken).toHaveBeenCalledTimes(1);
		const row = storedRow();
		expect(row.identifier).toBe('user@example.com');
		expect(row.token).toBe(hashToken(query.token));
		const expiresMs = row.expires.valueOf() - before;
		expect(expiresMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
		expect(expiresMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);

		expect(sendMagicLink).toHaveBeenCalledWith({email: 'user@example.com', url: url.toString()});
		expect(res.json).toHaveBeenCalledWith({ok: true});
		expect(res.status).not.toHaveBeenCalled();
	});

	test('normalizes the email: trimmed, lowercase, domain cut at the first comma', async () => {
		const {query} = await sendFlow({email: '  User@Example.COM,evil.com '});

		expect(query.email).toBe('user@example.com');
		expect(storedRow().identifier).toBe('user@example.com');
	});

	test('rejects an invalid email with EmailSignin before touching the db', async () => {
		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'not-an-email'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({error: 'EmailSignin'});
		expect(createVerificationToken).not.toHaveBeenCalled();
		expect(sendMagicLink).not.toHaveBeenCalled();
	});

	test('rejects multiple @s and quoted locals', async () => {
		const {handleEmailSignInRoute} = await importRoutes();
		for (const email of ['a@b@example.com', '"a@b"@example.com', 'user@localhost']) {
			const res = makeRes();
			await handleEmailSignInRoute({body: {email}} as never, res as never);

			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(createVerificationToken).not.toHaveBeenCalled();
	});

	test('dev mode logs the link instead of sending, but still stores the token', async () => {
		mockEnv.NODE_ENV = 'development';

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'user@example.com'}} as never, res as never);

		expect(sendMagicLink).not.toHaveBeenCalled();
		expect(createVerificationToken).toHaveBeenCalledTimes(1);
		const logged = logInfo.mock.calls[0]?.[0] as string;
		expect(logged).toContain('[Magic Link] user@example.com:');
		expect(logged).toContain('https://app.example.com/auth/email/verify?');
		expect(res.json).toHaveBeenCalledWith({ok: true, logged: true});
	});

	test('without RESEND_KEY logs the link instead of sending', async () => {
		mockEnv.RESEND_KEY = undefined;

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'user@example.com'}} as never, res as never);

		expect(sendMagicLink).not.toHaveBeenCalled();
		expect(logInfo.mock.calls[0]?.[0] as string).toContain('[Magic Link] user@example.com:');
		expect(res.json).toHaveBeenCalledWith({ok: true, logged: true});
	});

	test('an address ALLOWED_SIGNUP_EMAILS leaves out, without an account → SignupNotAllowed, nothing stored or sent', async () => {
		mockEnv.ALLOWED_SIGNUP_EMAILS = ['me@example.com', '@example.org'];

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'stranger@example.com'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(res.json).toHaveBeenCalledWith({error: 'SignupNotAllowed'});
		expect(createVerificationToken).not.toHaveBeenCalled();
		expect(sendMagicLink).not.toHaveBeenCalled();
	});

	test('ALLOWED_SIGNUP_EMAILS lets in its addresses, its domains with or without the @, and anyone with an account', async () => {
		mockEnv.ALLOWED_SIGNUP_EMAILS = ['me@example.com', '@example.org', 'example.net'];
		const {handleEmailSignInRoute} = await importRoutes();

		for (const email of ['me@example.com', 'someone@example.org', 'someone@example.net']) {
			const res = makeRes();
			await handleEmailSignInRoute({body: {email}} as never, res as never);
			expect(res.json).toHaveBeenCalledWith({ok: true});
		}

		// A domain is the whole domain, not a suffix of another one.
		const lookalike = makeRes();
		await handleEmailSignInRoute({body: {email: 'someone@notexample.net'}} as never, lookalike as never);
		expect(lookalike.json).toHaveBeenCalledWith({error: 'SignupNotAllowed'});

		getUserByEmail.mockResolvedValue(Ok({id: 'user-1', email: 'old@example.com', name: null}));
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'old@example.com'}} as never, res as never);
		expect(res.json).toHaveBeenCalledWith({ok: true});
		expect(sendMagicLink).toHaveBeenCalledTimes(4);
	});

	test('mail failure → EmailSignin error', async () => {
		sendMagicLink.mockResolvedValue(Err(ApiErr.mailError('boom', new Error('boom'))));

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'user@example.com'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'EmailSignin'});
	});

	test('token store failure → EmailSignin error, no mail', async () => {
		createVerificationToken.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'user@example.com'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'EmailSignin'});
		expect(sendMagicLink).not.toHaveBeenCalled();
	});

	test('without AUTH_SECRET → EmailSignin error before touching the db', async () => {
		mockEnv.AUTH_SECRET = undefined;

		const {handleEmailSignInRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailSignInRoute({body: {email: 'user@example.com'}} as never, res as never);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({error: 'EmailSignin'});
		expect(createVerificationToken).not.toHaveBeenCalled();
	});

	test('drops a callbackUrl that escapes the origin', async () => {
		const {query} = await sendFlow({callbackUrl: '//evil.com'});

		expect(query.callbackUrl).toBe('/');
	});
});

describe('handleEmailVerifyRoute', () => {
	test('signs in an existing user: token consumed, emailVerified refreshed, session + cookie + redirect', async () => {
		const {query} = await sendFlow();
		const row = storedRow();
		useVerificationToken.mockResolvedValue(Ok(row));
		getUserByEmail.mockResolvedValue(Ok({id: 'user-1', email: 'user@example.com', name: 'Existing User'}));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		// Consumed with the same (identifier, hashed token) pair that was stored, so send and
		// verify hash the same way.
		expect(useVerificationToken).toHaveBeenCalledWith({identifier: row.identifier, token: row.token});

		expect(setUserEmailVerified).toHaveBeenCalledWith('user-1');
		expect(createUserFromEmail).not.toHaveBeenCalled();

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

	test('first verify for an unknown email creates the user and signs them in', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(createUserFromEmail).toHaveBeenCalledWith('user@example.com');
		expect(setUserEmailVerified).not.toHaveBeenCalled();
		expect(createSession).toHaveBeenCalledTimes(1);
		expect((createSession.mock.calls[0]?.[0] as {userId: string}).userId).toBe('user-new');
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');
	});

	test('a link for an address ALLOWED_SIGNUP_EMAILS no longer lists → SignupNotAllowed, no user', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));
		mockEnv.ALLOWED_SIGNUP_EMAILS = ['me@example.com'];

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=SignupNotAllowed');
		expect(createUserFromEmail).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('user creation failure → Callback error, no session', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));
		createUserFromEmail.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createSession).not.toHaveBeenCalled();
	});

	test('emailVerified update failure → Callback error, no session', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));
		getUserByEmail.mockResolvedValue(Ok({id: 'user-1', email: 'user@example.com', name: 'Existing User'}));
		setUserEmailVerified.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createSession).not.toHaveBeenCalled();
	});

	test('user lookup failure → Callback error, no user mutation', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));
		getUserByEmail.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createUserFromEmail).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	test('normalizes a re-cased verify email so the token lookup still matches the stored identifier', async () => {
		const {query} = await sendFlow();
		const row = storedRow();
		useVerificationToken.mockResolvedValue(Ok(row));
		getUserByEmail.mockResolvedValue(Ok({id: 'user-1', email: 'user@example.com', name: 'Existing User'}));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		// Casing changed in transit; the stored identifier is normalized.
		await handleEmailVerifyRoute(makeVerifyRequest({...query, email: 'User@Example.com'}) as never, res as never);

		expect(useVerificationToken).toHaveBeenCalledWith({identifier: 'user@example.com', token: row.token});
		expect(getUserByEmail).toHaveBeenCalledWith('user@example.com');
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');
	});

	test('a verify email that cannot be normalized → Verification error', async () => {
		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest({token: 'a'.repeat(64), email: 'not-an-email', callbackUrl: '/'}) as never, res as never);

		expect(useVerificationToken).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
	});

	test('missing token or email → Verification error', async () => {
		const {handleEmailVerifyRoute} = await importRoutes();
		const queries: Record<string, string>[] = [{email: 'user@example.com'}, {token: 'a'.repeat(64)}];
		for (const query of queries) {
			const res = makeRes();
			await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

			expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
		}
		expect(useVerificationToken).not.toHaveBeenCalled();
	});

	test('expired token → Verification error, no session, no user mutation', async () => {
		const {query} = await sendFlow();
		const row = storedRow();
		useVerificationToken.mockResolvedValue(Ok({...row, expires: new Date(Date.now() - 1000)}));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
		expect(createSession).not.toHaveBeenCalled();
		expect(createUserFromEmail).not.toHaveBeenCalled();
		expect(setUserEmailVerified).not.toHaveBeenCalled();
	});

	test('unknown token → Verification error', async () => {
		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest({token: 'a'.repeat(64), email: 'user@example.com', callbackUrl: '/'}) as never, res as never);

		expect(useVerificationToken).toHaveBeenCalledWith({
			identifier: 'user@example.com',
			token: hashToken('a'.repeat(64)),
		});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
		expect(createSession).not.toHaveBeenCalled();
	});

	test('replaying a consumed link fails: second verify gets Verification, one session total', async () => {
		const {query} = await sendFlow();
		// The first use deletes the row; the replay finds nothing.
		useVerificationToken.mockResolvedValueOnce(Ok(storedRow())).mockResolvedValue(Ok(null));

		const {handleEmailVerifyRoute} = await importRoutes();
		const first = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, first as never);
		expect(first.redirect).toHaveBeenCalledWith('https://app.example.com/projects/abc');

		const second = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, second as never);
		expect(second.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
		expect(createSession).toHaveBeenCalledTimes(1);
	});

	test('db failure while consuming the token → Callback error', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest(query) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Callback');
		expect(createSession).not.toHaveBeenCalled();
	});

	test('drops a callbackUrl that escapes the origin', async () => {
		const {query} = await sendFlow();
		useVerificationToken.mockResolvedValue(Ok(storedRow()));

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest({...query, callbackUrl: '//evil.com'}) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/');
	});

	test('without AUTH_SECRET → Verification error, or a 500 when APP_URL is unset too', async () => {
		mockEnv.AUTH_SECRET = undefined;

		const {handleEmailVerifyRoute} = await importRoutes();
		const res = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest({token: 'a'.repeat(64), email: 'user@example.com'}) as never, res as never);

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/login?error=Verification');
		expect(useVerificationToken).not.toHaveBeenCalled();

		mockEnv.APP_URL = undefined;
		const bare = makeRes();
		await handleEmailVerifyRoute(makeVerifyRequest({token: 'a'.repeat(64), email: 'user@example.com'}) as never, bare as never);

		expect(bare.status).toHaveBeenCalledWith(500);
		expect(bare.json).toHaveBeenCalledWith({error: 'email_auth_not_configured'});
		expect(bare.redirect).not.toHaveBeenCalled();
	});
});
