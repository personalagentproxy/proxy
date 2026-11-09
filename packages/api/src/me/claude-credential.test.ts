import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const refreshCredential = mock();
const oauth = await import('./claude-oauth');
mock.module('./claude-oauth', () => ({...oauth, refreshCredential}));

// The one row of the fake database, and the locked updates applied to it as the real one would.
type Row = {
	id: string;
	userId: string;
	kind: 'oauth' | 'setup_token' | 'api_key';
	credential: string;
	email: null;
	subscriptionType: null;
	expiresAt: Date | null;
	lastRefreshedAt: Date | null;
	failedAt: Date | null;
	failure: string | null;
	createdAt: Date;
	updatedAt: Date;
};
let row: Row | null = null;
let locks = 0;
const updateClaudeAccountLocked = mock(async (userId: string, fn: (row: Row) => Promise<{update: Partial<Row> | null; value: unknown}>) => {
	if (!row || row.userId !== userId) {
		return Ok(null);
	}
	locks += 1;
	const {update, value} = await fn(row);
	if (update) {
		row = {...row, ...update};
	}
	return Ok(value);
});
mock.module('@proxy/db/claude-account', () => ({updateClaudeAccountLocked}));

const {encryptSecret, decryptSecret} = await import('../utils/secret-crypto');
const {claudeCredentialFor, encryptOauthCredential} = await import('./claude-credential');

function stored(credential: object): string {
	return encryptSecret(JSON.stringify(credential)).unwrap();
}

function setRow(kind: Row['kind'], credential: object, expiresAt: Date | null = null) {
	row = {
		id: 'claude-1',
		userId: 'user-1',
		kind,
		credential: stored(credential),
		email: null,
		subscriptionType: null,
		expiresAt,
		lastRefreshedAt: null,
		failedAt: null,
		failure: null,
		createdAt: new Date('2026-11-01T00:00:00Z'),
		updatedAt: new Date('2026-11-01T00:00:00Z'),
	};
}

const HOUR = 60 * 60 * 1000;

function oauthRow(expiresAt: Date) {
	setRow('oauth', {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: expiresAt.toISOString(), scopes: ['user:inference']}, expiresAt);
}

beforeEach(() => {
	mock.clearAllMocks();
	row = null;
	locks = 0;
});

describe('claudeCredentialFor', () => {
	test('null for a member who connected none', async () => {
		expect((await claudeCredentialFor('user-1')).unwrap()).toBeNull();
	});

	test('a sign-in with time left is handed out as stored, without a call to Claude', async () => {
		oauthRow(new Date(Date.now() + HOUR));
		expect((await claudeCredentialFor('user-1')).unwrap()).toEqual({kind: 'oauth', accessToken: 'access-1', scopes: ['user:inference']});
		expect(refreshCredential).not.toHaveBeenCalled();
		expect(locks).toBe(1);
	});

	test('one near its end is refreshed under the lock and the rotated pair stored encrypted with the new expiry', async () => {
		oauthRow(new Date(Date.now() + 2 * 60 * 1000));
		const newExpiry = new Date(Date.now() + 8 * HOUR);
		refreshCredential.mockResolvedValue(Ok({accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: newExpiry, scopes: ['user:profile', 'user:inference']}));

		expect((await claudeCredentialFor('user-1')).unwrap()).toEqual({kind: 'oauth', accessToken: 'access-2', scopes: ['user:profile', 'user:inference']});

		expect(refreshCredential).toHaveBeenCalledWith({accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: expect.any(Date), scopes: ['user:inference']});
		expect(row?.expiresAt).toEqual(newExpiry);
		expect(row?.lastRefreshedAt).toBeInstanceOf(Date);
		expect(row?.credential).not.toContain('refresh-2');
		expect(JSON.parse(decryptSecret(row?.credential ?? '').unwrap())).toEqual({
			accessToken: 'access-2',
			refreshToken: 'refresh-2',
			expiresAt: newExpiry.toISOString(),
			scopes: ['user:profile', 'user:inference'],
		});
	});

	test('a forced refresh refreshes however much time is left', async () => {
		oauthRow(new Date(Date.now() + HOUR));
		refreshCredential.mockResolvedValue(Ok({accessToken: 'access-2', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 8 * HOUR), scopes: ['user:inference']}));

		expect((await claudeCredentialFor('user-1', {forceRefresh: true})).unwrap()).toMatchObject({accessToken: 'access-2'});
		expect(refreshCredential).toHaveBeenCalledTimes(1);
	});

	test('a refused refresh marks the account failed, keeps the tokens, and is the error', async () => {
		oauthRow(new Date(Date.now() - HOUR));
		refreshCredential.mockResolvedValue(Err(ApiErr.unavailable('Your Claude sign-in expired or was refused. Connect it again on the Account page.')));
		const before = row?.credential;

		const error = (await claudeCredentialFor('user-1')).unwrapErr();

		expect(error.kind).toBe('unavailable');
		expect(row?.failedAt).toBeInstanceOf(Date);
		expect(row?.failure).toContain('Connect it again');
		expect(row?.credential).toBe(before);
	});

	test('an unreachable endpoint is the error and marks nothing', async () => {
		oauthRow(new Date(Date.now() - HOUR));
		refreshCredential.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		expect((await claudeCredentialFor('user-1')).unwrapErr().kind).toBe('provider_unreachable');
		expect(row?.failedAt).toBeNull();
	});

	test('a setup token and an API key pass through as pasted', async () => {
		setRow('setup_token', {token: 'sk-ant-oat01-abc'});
		expect((await claudeCredentialFor('user-1')).unwrap()).toEqual({kind: 'setup_token', token: 'sk-ant-oat01-abc'});

		setRow('api_key', {key: 'sk-ant-api03-abc'});
		expect((await claudeCredentialFor('user-1')).unwrap()).toEqual({kind: 'api_key', key: 'sk-ant-api03-abc'});
		expect(refreshCredential).not.toHaveBeenCalled();
	});

	test('encryptOauthCredential stores the expiry as a date string', () => {
		const expiresAt = new Date('2026-11-09T12:00:00.000Z');
		const encrypted = encryptOauthCredential({accessToken: 'a', refreshToken: 'r', expiresAt, scopes: ['s']}).unwrap();
		expect(JSON.parse(decryptSecret(encrypted).unwrap())).toEqual({accessToken: 'a', refreshToken: 'r', expiresAt: '2026-11-09T12:00:00.000Z', scopes: ['s']});
	});
});
