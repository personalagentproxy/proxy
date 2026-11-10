import {createHash} from 'node:crypto';

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';

import {
	AUTHORIZE_URL,
	authorizeUrl,
	CLIENT_ID,
	exchangeCode,
	makePkce,
	ONE_YEAR_SECONDS,
	parsePastedCode,
	REDIRECT_URI,
	TOKEN_URL,
} from './claude-oauth';

// What the token endpoint was sent, and what it answers: Bun's fetch carries `preconnect`, so the
// stub borrows the real one to stand in for it.
function stubTokenEndpoint(answer: () => Response): {
	posted: () => Record<string, string | number>;
	url: () => string;
} {
	const calls: Array<{url: string; body: string}> = [];
	spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({url: String(input), body: String(init?.body)});
				return answer();
			},
			{preconnect: fetch.preconnect},
		),
	);
	return {
		posted: () => JSON.parse(calls[0]?.body ?? '{}') as Record<string, string | number>,
		url: () => calls[0]?.url ?? '',
	};
}

function json(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {'Content-Type': 'application/json'},
	});
}

afterEach(() => {
	mock.restore();
});

describe('makePkce', () => {
	test('answers a verifier and its S256 challenge, fresh each time', () => {
		const first = makePkce();
		const second = makePkce();
		expect(first.challenge).toBe(createHash('sha256').update(first.verifier).digest('base64url'));
		expect(first.verifier).not.toBe(second.verifier);
	});
});

describe('authorizeUrl', () => {
	test("is Claude Code's client, the manual code page, the inference scope alone and the attempt's PKCE challenge and state", () => {
		const url = new URL(authorizeUrl({challenge: 'chal', state: 'st'}));
		expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			code: 'true',
			client_id: CLIENT_ID,
			response_type: 'code',
			redirect_uri: REDIRECT_URI,
			scope: 'user:inference',
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
	test("posts the code with the verifier, the state and a year's expiry, and answers the token with when it ends", async () => {
		const endpoint = stubTokenEndpoint(() =>
			json({
				access_token: 'sk-ant-oat01-minted',
				refresh_token: 'dropped',
				expires_in: ONE_YEAR_SECONDS,
				scope: 'user:inference',
			}),
		);
		const before = Date.now();

		const minted = (await exchangeCode({code: 'the-code', verifier: 'ver', state: 'st'})).unwrap();

		expect(endpoint.url()).toBe(TOKEN_URL);
		expect(endpoint.posted()).toEqual({
			grant_type: 'authorization_code',
			code: 'the-code',
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: 'ver',
			state: 'st',
			expires_in: 31_536_000,
		});
		expect(minted).toEqual({token: 'sk-ant-oat01-minted', expiresAt: expect.any(Date)});
		expect(minted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ONE_YEAR_SECONDS * 1000);
		expect(minted.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ONE_YEAR_SECONDS * 1000);
	});

	test('takes an answer without a refresh token or scope', async () => {
		stubTokenEndpoint(() => json({access_token: 'tok', expires_in: 60}));
		expect((await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrap().token).toBe('tok');
	});

	test('a refusal is unavailable, with words for the person; an unreachable endpoint says so', async () => {
		stubTokenEndpoint(() => json({error: 'invalid_grant'}, 400));
		const refused = (await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrapErr();
		expect(refused.kind).toBe('unavailable');
		expect('message' in refused && refused.message).toBe('Claude sign-in failed. Try again.');

		mock.restore();
		stubTokenEndpoint(() => {
			throw new Error('down');
		});
		expect((await exchangeCode({code: 'c', verifier: 'v', state: 's'})).unwrapErr().kind).toBe(
			'provider_unreachable',
		);
	});
});
