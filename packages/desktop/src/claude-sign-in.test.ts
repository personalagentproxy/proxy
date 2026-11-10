import {createHash} from 'node:crypto';

import {describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';
import {AUTHORIZE_URL, CLIENT_ID} from '@proxy/utils/claude-oauth';

import {createClaudeSignIn} from './claude-sign-in';

const ENDS_AT = new Date('2027-11-10T12:00:00.000Z');

// A sign-in over a browser and a token endpoint that answer as told, keeping what they were asked.
function fakeSignIn({
	open = async () => undefined,
	exchange = async () => Ok({token: 'sk-ant-oat01-minted', expiresAt: ENDS_AT}),
}: {
	open?: () => Promise<void>;
	exchange?: Parameters<typeof createClaudeSignIn>[0]['exchange'];
} = {}) {
	const openExternal = mock(async (_url: string) => open());
	const exchanged = mock(exchange);
	return {
		signIn: createClaudeSignIn({openExternal, exchange: exchanged}),
		openExternal,
		exchanged,
		opened: () => new URL(openExternal.mock.calls[0]?.[0] ?? ''),
		// A parameter of the n-th page opened, as a string, so the tests can hand it back.
		param: (name: string, nth = 0) =>
			new URL(openExternal.mock.calls[nth]?.[0] ?? '').searchParams.get(name) ?? '',
	};
}

describe('createClaudeSignIn', () => {
	test("start opens Claude's sign-in page in the browser, as Claude Code's client with a challenge and a state", async () => {
		const {signIn, opened} = fakeSignIn();

		expect(await signIn.start()).toEqual({ok: true});

		const url = opened();
		expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(url.searchParams.get('code_challenge')).toHaveLength(43);
		expect(url.searchParams.get('state')).toHaveLength(43);
	});

	test('start says so when the browser could not be opened', async () => {
		const {signIn} = fakeSignIn({
			open: async () => {
				throw new Error('no browser');
			},
		});

		expect(await signIn.start()).toEqual({error: 'Claude sign-in failed. Try again.'});
	});

	test("finish trades the pasted code, with the attempt's verifier and state, for the token and when it ends", async () => {
		const {signIn, param, exchanged} = fakeSignIn();
		await signIn.start();
		const state = param('state');

		expect(await signIn.finish(`  the-code#${state}  `)).toEqual({
			token: 'sk-ant-oat01-minted',
			expiresAt: '2027-11-10T12:00:00.000Z',
		});

		const sent = exchanged.mock.calls[0]?.[0];
		expect(sent?.code).toBe('the-code');
		expect(sent?.state).toBe(param('state'));
		expect(
			createHash('sha256')
				.update(sent?.verifier ?? '')
				.digest('base64url'),
		).toBe(param('code_challenge'));
	});

	test('finish without a start, or after one finished, asks to open Claude again', async () => {
		const {signIn, opened, exchanged} = fakeSignIn();
		const beforeAny = await signIn.finish('the-code#some-state');
		expect('error' in beforeAny && beforeAny.error).toContain('Open Claude again');

		await signIn.start();
		const state = opened().searchParams.get('state');
		await signIn.finish(`the-code#${state}`);
		const again = await signIn.finish(`the-code#${state}`);
		expect('error' in again && again.error).toContain('Open Claude again');
		expect(exchanged).toHaveBeenCalledTimes(1);
	});

	test('finish refuses an incomplete code, or one from another attempt, and keeps the attempt', async () => {
		const {signIn, opened, exchanged} = fakeSignIn();
		await signIn.start();
		const state = opened().searchParams.get('state');

		expect(await signIn.finish('the-code')).toEqual({
			error: 'Paste the complete code from Claude.',
		});
		const other = await signIn.finish('the-code#other-state');
		expect('error' in other && other.error).toContain('different sign-in attempt');
		expect(exchanged).not.toHaveBeenCalled();

		expect('token' in (await signIn.finish(`the-code#${state}`))).toBe(true);
	});

	test('a new start replaces the attempt: the earlier code is from another attempt then', async () => {
		const {signIn, param} = fakeSignIn();
		await signIn.start();
		const first = param('state');
		await signIn.start();
		const second = param('state', 1);
		expect(second).not.toBe(first);

		const stale = await signIn.finish(`the-code#${first}`);
		expect('error' in stale && stale.error).toContain('different sign-in attempt');
		expect('token' in (await signIn.finish(`the-code#${second}`))).toBe(true);
	});

	test("finish passes on the exchange's words when Claude refused the code or could not be reached", async () => {
		const refused = fakeSignIn({
			exchange: async () => Err(ApiErr.unavailable('Claude sign-in failed. Try again.')),
		});
		await refused.signIn.start();
		const state = refused.opened().searchParams.get('state');
		expect(await refused.signIn.finish(`the-code#${state}`)).toEqual({
			error: 'Claude sign-in failed. Try again.',
		});

		const unreachable = fakeSignIn({
			exchange: async () => Err(ApiErr.providerUnreachable(new Error('down'))),
		});
		await unreachable.signIn.start();
		expect(
			await unreachable.signIn.finish(`the-code#${unreachable.opened().searchParams.get('state')}`),
		).toEqual({error: 'Claude sign-in failed. Try again.'});
	});
});
