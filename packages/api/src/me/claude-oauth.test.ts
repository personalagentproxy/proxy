import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

const actual = await import('@proxy/utils');
const httpRequest = mock();
mock.module('@proxy/utils', () => ({...actual, httpRequest}));

const {AUTHORIZE_URL, CLIENT_ID, REDIRECT_URI, TOKEN_URL, authorizeUrl, classifyPastedToken, exchangeCode, parsePastedCode, refreshCredential} = await import('./claude-oauth');

type FetchError = import('@proxy/utils').FetchError;

function http(status: number): FetchError {
	return {kind: 'http', url: TOKEN_URL, status, body: null};
}

const network: FetchError = {kind: 'network', url: TOKEN_URL, cause: new Error('down')};

// The body the last call posted.
function postedBody(call = 0): Record<string, string> {
	const init = httpRequest.mock.calls[call]?.[1] as {body: string};
	return JSON.parse(init.body) as Record<string, string>;
}

beforeEach(() => {
	mock.clearAllMocks();
});

describe('authorizeUrl', () => {
	test("is Claude Code's client, the manual code page, both scopes and the attempt's PKCE challenge and state", () => {
		const url = new URL(authorizeUrl({challenge: 'chal', state: 'st'}));
		expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			code: 'true',
			client_id: CLIENT_ID,
			response_type: 'code',
			redirect_uri: REDIRECT_URI,
			scope: 'user:profile user:inference',
			code_challenge: 'chal',
			code_challenge_method: 'S256',
			state: 'st',
		});
	});
});

describe('parsePastedCode', () => {
	test('splits the code from the state at the last #, trimming what was pasted', () => {
		expect(parsePastedCode('  abc#def#st  ', 'st').unwrap()).toBe('abc#def');
	});

	test('wants the whole code: no #, or nothing on a side of it', () => {
		for (const pasted of ['abc', '#st', 'abc#', '#']) {
			const error = parsePastedCode(pasted, 'st').unwrapErr();
			expect(error.kind).toBe('validation_error');
			expect('message' in error && error.message).toBe('Paste the complete code from Claude.');
		}
	});

	test("refuses a code from another attempt, whose state isn't this one's", () => {
		const error = parsePastedCode('abc#other', 'st').unwrapErr();
		expect(error.kind).toBe('validation_error');
		expect('message' in error && error.message).toContain('different sign-in attempt');
	});
});

describe('exchangeCode', () => {
	test('posts the code with the verifier and state, and answers the tokens with their expiry and scopes', async () => {
		httpRequest.mockResolvedValue(Ok({access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user:profile user:inference'}));
		const before = Date.now();

		const credential = (await exchangeCode({code: 'the-code', verifier: 'ver', state: 'st'})).unwrap();

		expect(httpRequest.mock.calls[0]?.[0]).toBe(TOKEN_URL);
		expect(postedBody()).toEqual({grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: 'ver', state: 'st'});
		expect(credential.accessToken).toBe('access');
		expect(credential.refreshToken).toBe('refresh');
		expect(credential.scopes).toEqual(['user:profile', 'user:inference']);
		expect(credential.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
		expect(credential.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
	});

	test('takes the scopes asked for when the answer names none', async () => {
		httpRequest.mockResolvedValue(Ok({access_token: 'access', refresh_token: 'refresh', expires_in: 60}));
		expect((await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrap().scopes).toEqual(['user:profile', 'user:inference']);
	});

	test('a refusal is unavailable, with words for the person; an unreachable endpoint says so', async () => {
		httpRequest.mockResolvedValueOnce(Err(http(400)));
		const refused = (await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrapErr();
		expect(refused.kind).toBe('unavailable');
		expect('message' in refused && refused.message).toBe('Claude sign-in failed. Try again.');

		httpRequest.mockResolvedValueOnce(Err(network));
		expect((await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrapErr().kind).toBe('provider_unreachable');
	});
});

const credential = {accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: new Date('2026-11-09T10:00:00Z'), scopes: ['user:inference']};

describe('refreshCredential', () => {
	test('posts the refresh token and answers the rotated pair', async () => {
		httpRequest.mockResolvedValue(Ok({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'user:profile user:inference'}));

		const refreshed = (await refreshCredential(credential)).unwrap();

		expect(postedBody()).toEqual({grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: CLIENT_ID});
		expect(refreshed.accessToken).toBe('new-access');
		expect(refreshed.refreshToken).toBe('new-refresh');
		expect(refreshed.scopes).toEqual(['user:profile', 'user:inference']);
		expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	test('keeps the refresh token and scopes when the answer has none', async () => {
		httpRequest.mockResolvedValue(Ok({access_token: 'new-access', expires_in: 3600}));
		const refreshed = (await refreshCredential(credential)).unwrap();
		expect(refreshed.refreshToken).toBe('old-refresh');
		expect(refreshed.scopes).toEqual(['user:inference']);
	});

	test('a 400 or 401 means the grant is gone: no retry, and the words say to connect again', async () => {
		for (const status of [400, 401]) {
			httpRequest.mockClear();
			httpRequest.mockResolvedValue(Err(http(status)));
			const error = (await refreshCredential(credential)).unwrapErr();
			expect(error.kind).toBe('unavailable');
			expect('message' in error && error.message).toContain('Connect it again on the Account page.');
			expect(httpRequest).toHaveBeenCalledTimes(1);
		}
	});

	test('a 5xx or a network failure is tried twice more, then the endpoint is unreachable', async () => {
		httpRequest
			.mockResolvedValueOnce(Err(http(502)))
			.mockResolvedValueOnce(Err(network))
			.mockResolvedValueOnce(Err(http(503)));
		const error = (await refreshCredential(credential)).unwrapErr();
		expect(error.kind).toBe('provider_unreachable');
		expect(httpRequest).toHaveBeenCalledTimes(3);
	});

	test('a retry that succeeds answers the tokens', async () => {
		httpRequest.mockResolvedValueOnce(Err(network)).mockResolvedValueOnce(Ok({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60}));
		expect((await refreshCredential(credential)).unwrap().accessToken).toBe('new-access');
		expect(httpRequest).toHaveBeenCalledTimes(2);
	});
});

describe('classifyPastedToken', () => {
	test('tells a setup token from an API key by its prefix', () => {
		expect(classifyPastedToken('sk-ant-oat01-abc').unwrap()).toBe('setup_token');
		expect(classifyPastedToken('sk-ant-api03-abc').unwrap()).toBe('api_key');
	});

	test('refuses anything else, saying what to paste', () => {
		const error = classifyPastedToken('hunter2').unwrapErr();
		expect(error.kind).toBe('validation_error');
		expect('message' in error && error.message).toContain('claude setup-token');
	});
});
