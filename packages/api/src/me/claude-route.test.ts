import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {ClaudeAccount} from '@proxy/contracts/me';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), APP_URL: 'http://localhost:5173'}}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const getClaudeAccount = mock();
const upsertClaudeAccount = mock();
const deleteClaudeAccount = mock();
mock.module('@proxy/db/claude-account', () => ({getClaudeAccount, upsertClaudeAccount, deleteClaudeAccount}));

const {decryptSecret} = await import('../utils/secret-crypto');
const {handleClaudeTokenRoute, handleDeleteClaudeAccountRoute, handleGetClaudeAccountRoute} = await import('./claude-route');

function makeRequest(body?: unknown) {
	return {
		body,
		headers: {},
		user: {userId: 'user-1', sessionId: 'session-1', email: 'person@example.com'},
	} as never;
}

const now = new Date('2026-11-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const row = {
	id: 'claude-1',
	userId: 'user-1',
	kind: 'setup_token',
	credential: 'enc:token',
	expiresAt: new Date('2027-11-09T20:00:00.000Z'),
	failedAt: null,
	failure: null,
	usageFiveHourUtilization: null,
	usageFiveHourResetsAt: null,
	usageSevenDayUtilization: null,
	usageSevenDayResetsAt: null,
	usageReadAt: null,
	createdAt: new Date('2026-11-09T12:00:00.000Z'),
	updatedAt: new Date('2026-11-09T12:00:00.000Z'),
};

// What the GET shape says of `row`.
const describedAccount: NonNullable<ClaudeAccount['account']> = {
	kind: 'setup_token',
	expiresAt: '2027-11-09T20:00:00.000Z',
	failure: null,
	connectedAt: '2026-11-09T12:00:00.000Z',
	usage: null,
};

// The last call's stored account.
function stored(): {kind: string; credential: string; expiresAt: Date | null} {
	return (upsertClaudeAccount.mock.calls[0] as [string, {kind: string; credential: string; expiresAt: Date | null}])[1];
}

beforeEach(() => {
	mock.clearAllMocks();
	getClaudeAccount.mockResolvedValue(Ok(null));
	upsertClaudeAccount.mockResolvedValue(Ok(row));
	deleteClaudeAccount.mockResolvedValue(Ok(undefined));
});

describe('handleGetClaudeAccountRoute', () => {
	test('null for a member who connected none', async () => {
		expect((await handleGetClaudeAccountRoute(makeRequest())).unwrap()).toEqual({account: null});
		expect(getClaudeAccount).toHaveBeenCalledWith('user-1');
	});

	test('the kind, the expiry and the failure, never the credential; no usage before a turn said', async () => {
		getClaudeAccount.mockResolvedValue(Ok({...row, failure: 'refused', failedAt: new Date()}));
		const answered = (await handleGetClaudeAccountRoute(makeRequest())).unwrap();
		expect(answered).toEqual({account: {...describedAccount, failure: 'refused'}});
		expect(JSON.stringify(answered)).not.toContain('enc:token');
	});

	test('the usage as the last turn had it, a window the provider never spoke of as null', async () => {
		getClaudeAccount.mockResolvedValue(
			Ok({
				...row,
				usageFiveHourUtilization: 0.37,
				usageFiveHourResetsAt: new Date('2026-11-10T15:00:00.000Z'),
				usageSevenDayUtilization: 0.12,
				usageSevenDayResetsAt: null,
				usageReadAt: new Date('2026-11-10T12:30:00.000Z'),
			}),
		);
		expect((await handleGetClaudeAccountRoute(makeRequest())).unwrap().account?.usage).toEqual({
			fiveHour: {utilization: 0.37, resetsAt: '2026-11-10T15:00:00.000Z'},
			sevenDay: {utilization: 0.12, resetsAt: null},
			readAt: '2026-11-10T12:30:00.000Z',
		});

		getClaudeAccount.mockResolvedValue(Ok({...row, usageSevenDayUtilization: 0.12, usageReadAt: new Date('2026-11-10T12:30:00.000Z')}));
		expect((await handleGetClaudeAccountRoute(makeRequest())).unwrap().account?.usage).toEqual({fiveHour: null, sevenDay: {utilization: 0.12, resetsAt: null}, readAt: '2026-11-10T12:30:00.000Z'});
	});
});

describe('handleClaudeTokenRoute', () => {
	test('a setup token is stored encrypted as its kind, with the end it was sent with', async () => {
		const answered = (await handleClaudeTokenRoute(makeRequest({token: 'sk-ant-oat01-abc', expiresAt: '2027-11-09T20:00:00.000Z'}), now)).unwrap();

		expect(answered.account?.kind).toBe('setup_token');
		expect(answered.account?.expiresAt).toBe('2027-11-09T20:00:00.000Z');
		expect(upsertClaudeAccount.mock.calls[0]?.[0]).toBe('user-1');
		expect(stored().kind).toBe('setup_token');
		expect(stored().expiresAt).toEqual(new Date('2027-11-09T20:00:00.000Z'));
		expect(stored().credential).not.toContain('sk-ant');
		expect(JSON.parse(decryptSecret(stored().credential).unwrap())).toEqual({token: 'sk-ant-oat01-abc'});
	});

	test('a pasted token without an end is stored with none', async () => {
		upsertClaudeAccount.mockResolvedValue(Ok({...row, expiresAt: null}));
		const answered = (await handleClaudeTokenRoute(makeRequest({token: 'sk-ant-oat01-abc'}), now)).unwrap();
		expect(answered.account?.expiresAt).toBeNull();
		expect(stored().expiresAt).toBeNull();
	});

	test('an end that has passed, or is further off than a token can be minted for, is a bad request', async () => {
		const past = (await handleClaudeTokenRoute(makeRequest({token: 'sk-ant-oat01-abc', expiresAt: '2026-11-10T12:00:00.000Z'}), now)).unwrapErr();
		expect(past.kind).toBe('validation_error');
		expect('message' in past && past.message).toContain('run out already');

		const far = (await handleClaudeTokenRoute(makeRequest({token: 'sk-ant-oat01-abc', expiresAt: new Date(now.getTime() + 401 * DAY_MS).toISOString()}), now)).unwrapErr();
		expect(far.kind).toBe('validation_error');
		expect('message' in far && far.message).toContain('400 days');

		expect((await handleClaudeTokenRoute(makeRequest({token: 'sk-ant-oat01-abc', expiresAt: 'tomorrow'}), now)).unwrapErr().kind).toBe('parse_error');
		expect(upsertClaudeAccount).not.toHaveBeenCalled();
	});

	test('an API key is stored as a key, whatever end was sent', async () => {
		upsertClaudeAccount.mockResolvedValue(Ok({...row, kind: 'api_key', expiresAt: null}));
		const answered = (await handleClaudeTokenRoute(makeRequest({token: '  sk-ant-api03-abc  ', expiresAt: '2020-01-01T00:00:00.000Z'}), now)).unwrap();
		expect(answered.account?.kind).toBe('api_key');
		expect(stored().kind).toBe('api_key');
		expect(stored().expiresAt).toBeNull();
		expect(JSON.parse(decryptSecret(stored().credential).unwrap())).toEqual({key: 'sk-ant-api03-abc'});
	});

	test('anything else is refused, saying what to paste', async () => {
		const error = (await handleClaudeTokenRoute(makeRequest({token: 'hunter2'}), now)).unwrapErr();
		expect(error.kind).toBe('validation_error');
		expect('message' in error && error.message).toContain('claude setup-token');
		expect(upsertClaudeAccount).not.toHaveBeenCalled();
	});
});

describe('handleDeleteClaudeAccountRoute', () => {
	test('disconnects and answers no account', async () => {
		expect((await handleDeleteClaudeAccountRoute(makeRequest())).unwrap()).toEqual({account: null});
		expect(deleteClaudeAccount).toHaveBeenCalledWith('user-1');
	});
});
