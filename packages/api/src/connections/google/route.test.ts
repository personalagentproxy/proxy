import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const renewConnection = mock();

mock.module('@proxy/db/connection', () => ({
	getConnectionWithCredential: mock(),
	findAccountConnection,
	createConnection,
	renewConnection,
	shareConnection: mock(),
	updateConnectionCredential: mock(),
	getConnectionCredential: mock(async () => Ok(null)),
	updateConnectionTools: mock(),
	updateConnectionName: mock(),
}));

mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

const requireViewer = mock(async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}));

mock.module('../../utils/user-org', () => ({requireViewer, requireOwner: requireViewer}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const env: {NODE_ENV: string; APP_URL: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string} = {NODE_ENV: 'production', APP_URL: 'https://app.example.com'};

mock.module('../../utils/env', () => ({env}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const CALLBACK = 'https://app.example.com/api/connections/google/callback';

const SCOPES = [
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/gmail.send',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/documents',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/presentations',
	'https://www.googleapis.com/auth/contacts',
];

function base64url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(payload: object): string {
	return `${base64url({alg: 'RS256'})}.${base64url(payload)}.signature`;
}

const ID_TOKEN = idToken({sub: '1093', email: 'Alex@Example.com', email_verified: true});

// Google's token endpoint: each request, and its answer. The person unticked Gmail on the consent screen.
const google = {requests: [] as Array<{url: URL; body: URLSearchParams}>, idToken: ID_TOKEN, refusal: null as object | null};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	google.requests.push({url, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	if (google.refusal) {
		return Response.json(google.refusal, {status: 401});
	}
	return Response.json({
		access_token: 'access-1',
		refresh_token: 'refresh-1',
		expires_in: 3599,
		token_type: 'Bearer',
		scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents',
		id_token: google.idToken,
	});
}) as typeof fetch);

function makeRes() {
	const cookies: Array<{name: string; value: string; options: Record<string, unknown>}> = [];
	const res = {
		cookies,
		redirect: mock(),
		cookie: mock((name: string, value: string, options: Record<string, unknown>) => {
			cookies.push({name, value, options});
		}),
		clearCookie: mock(),
		status: mock(() => res),
		json: mock(() => res),
	};
	return res;
}

const user = {userId: 'user-1', email: 'alex@example.com'};

async function start(query: Record<string, string> = {}) {
	const {handleStartGoogleRoute} = await import('./route');
	const res = makeRes();
	await handleStartGoogleRoute({user, params: {org: 'org-1'}, query, headers: {}} as never, res as never);
	const cookie = res.cookies.find((candidate) => candidate.name === 'proxy.google-state');
	const redirect = String(res.redirect.mock.calls[0]?.[0]);
	const authorizeUrl = URL.canParse(redirect) ? new URL(redirect) : null;
	return {res, cookie, authorizeUrl, state: authorizeUrl?.searchParams.get('state') ?? ''};
}

async function callback(args: {cookie: string; query: Record<string, string>}) {
	const {handleGoogleCallbackRoute} = await import('./route');
	const res = makeRes();
	await handleGoogleCallbackRoute({user, params: {org: 'org-1'}, query: args.query, headers: {cookie: `proxy.google-state=${args.cookie}`}} as never, res as never);
	return res;
}

beforeEach(() => {
	mock.clearAllMocks();
	google.requests = [];
	google.idToken = ID_TOKEN;
	google.refusal = null;
	env.GOOGLE_CLIENT_ID = 'client-1.apps.googleusercontent.com';
	env.GOOGLE_CLIENT_SECRET = 'secret-1';
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockResolvedValue(Ok({id: 'conn-1'}));
	renewConnection.mockResolvedValue(Ok(undefined));
});

describe('handleStartGoogleRoute', () => {
	test('sends the browser to Google asking for every scope at once, offline, with PKCE', async () => {
		const {cookie, authorizeUrl} = await start();

		expect(authorizeUrl?.origin + (authorizeUrl?.pathname ?? '')).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		const params = authorizeUrl?.searchParams;
		expect(params?.get('client_id')).toBe('client-1.apps.googleusercontent.com');
		expect(params?.get('redirect_uri')).toBe(CALLBACK);
		expect(params?.get('scope')?.split(' ')).toEqual(SCOPES);
		expect(params?.get('access_type')).toBe('offline');
		expect(params?.get('prompt')).toBe('consent');
		expect(params?.get('include_granted_scopes')).toBe('true');
		expect(params?.get('code_challenge_method')).toBe('S256');
		expect(params?.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(cookie?.options).toMatchObject({httpOnly: true, sameSite: 'lax', path: '/api/connections/google'});
		expect(google.requests).toEqual([]);
	});

	test('signing in again from a connection opens Google on its account', async () => {
		const {authorizeUrl} = await start({account: 'alex@example.com'});

		expect(authorizeUrl?.searchParams.get('login_hint')).toBe('alex@example.com');
	});

	test('an account that is not an address is not passed on', async () => {
		const {authorizeUrl} = await start({account: 'not an address'});
		const {authorizeUrl: none} = await start();

		expect(authorizeUrl?.searchParams.has('login_hint')).toBe(false);
		expect(none?.searchParams.has('login_hint')).toBe(false);
	});

	test('without a Google client set up, goes back to the catalog saying so', async () => {
		env.GOOGLE_CLIENT_ID = undefined;
		const {res, cookie} = await start();
		const {res: welcome} = await start({returnTo: 'welcome'});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=google-unconfigured');
		expect(welcome.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/welcome/connections?error=google-unconfigured');
		expect(cookie).toBeUndefined();
	});
});

describe('handleGoogleCallbackRoute', () => {
	test('trades the code with the secret and verifier, and makes the connection for the address, agents reading files', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		const [exchange] = google.requests;
		expect(exchange?.url.href).toBe('https://oauth2.googleapis.com/token');
		expect(Object.fromEntries(exchange?.body ?? [])).toMatchObject({
			grant_type: 'authorization_code',
			code: 'code-1',
			client_id: 'client-1.apps.googleusercontent.com',
			client_secret: 'secret-1',
			redirect_uri: CALLBACK,
			code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
		});
		const created = createConnection.mock.calls[0]?.[0];
		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {integrationId: 'google', account: 'alex@example.com', providerAccountId: '1093'});
		expect(created).toMatchObject({orgId: 'org-1', integrationId: 'google', account: 'alex@example.com', providerAccountId: '1093', defaults: []});
		expect(JSON.parse(String(created.credential).replace(/^enc:/, ''))).toEqual({
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: expect.any(String),
			scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
			email: 'alex@example.com',
		});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-1?added');
	});

	test('signing in again with the same account gives its connection the new tokens', async () => {
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0'}));
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0'});
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/conn-0');
	});

	test("after the account's address changed, signing in again finds its connection by Google's id and gives it the new address", async () => {
		google.idToken = idToken({sub: '1093', email: 'alex.kim@example.com', email_verified: true});
		findAccountConnection.mockResolvedValue(Ok({id: 'conn-0'}));
		const {cookie, state} = await start();
		await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(findAccountConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), {
			integrationId: 'google',
			account: 'alex.kim@example.com',
			providerAccountId: '1093',
		});
		expect(renewConnection.mock.calls[0]?.[0]).toMatchObject({connectionId: 'conn-0', account: 'alex.kim@example.com', providerAccountId: '1093'});
		expect(JSON.parse(String(renewConnection.mock.calls[0]?.[0].credential).replace(/^enc:/, ''))).toMatchObject({email: 'alex.kim@example.com'});
	});

	test('an address Google has not verified is turned down', async () => {
		google.idToken = idToken({sub: '1093', email: 'alex@example.com', email_verified: false});
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(createConnection).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=google');
	});

	test("a client Google doesn't know is logged with Google's answer, not taken for a revoked sign-in", async () => {
		google.refusal = {error: 'invalid_client', error_description: 'The OAuth client was not found.'};
		const {exchangeGoogleCode} = await import('./google-oauth');
		const result = await exchangeGoogleCode({clientId: 'client-1', clientSecret: 'wrong'}, {redirectUri: CALLBACK, code: 'code-1', verifier: 'verifier'});

		expect(result.isErr() && result.error).toMatchObject({kind: 'provider_unreachable', cause: {kind: 'http', status: 401, body: {error: 'invalid_client'}}});
	});

	test('started from the welcome flow, ends on its page for the connection', async () => {
		const {cookie, state} = await start({returnTo: 'welcome'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state, code: 'code-1'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/welcome/connections/conn-1');
	});

	test('a state that does not match is turned down without asking Google', async () => {
		const {cookie} = await start({returnTo: 'welcome'});
		const res = await callback({cookie: cookie?.value ?? '', query: {state: 'forged', code: 'code-1'}});

		expect(google.requests).toEqual([]);
		expect(createConnection).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/welcome/connections?error=google');
	});

	test('a sign-in turned down at Google goes back to the catalog', async () => {
		const {cookie, state} = await start();
		const res = await callback({cookie: cookie?.value ?? '', query: {state, error: 'access_denied'}});

		expect(res.redirect).toHaveBeenCalledWith('https://app.example.com/org-1/connections/new?error=google');
		expect(createConnection).not.toHaveBeenCalled();
	});
});
