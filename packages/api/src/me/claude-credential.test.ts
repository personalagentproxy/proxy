import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// The one row of the fake database.
type Row = {
	id: string;
	userId: string;
	kind: 'setup_token' | 'api_key';
	credential: string;
	expiresAt: Date | null;
	failedAt: Date | null;
	failure: string | null;
	usageFiveHourUtilization: number | null;
	usageFiveHourResetsAt: Date | null;
	usageSevenDayUtilization: number | null;
	usageSevenDayResetsAt: Date | null;
	usageReadAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};
let row: Row | null = null;
const getClaudeAccount = mock(async (userId: string) => Ok(row?.userId === userId ? row : null));
const markClaudeAccountFailed = mock(async (userId: string, failure: string) => {
	if (row?.userId === userId) {
		row = {...row, failedAt: new Date(), failure};
	}
	return Ok(undefined);
});
const setClaudeAccountUsage = mock(async () => Ok(undefined));
mock.module('@proxy/db/claude-account', () => ({getClaudeAccount, markClaudeAccountFailed, setClaudeAccountUsage}));

const {encryptSecret} = await import('../utils/secret-crypto');
const {claudeCredentialFor, markClaudeCredentialRefused, recordClaudeUsage} = await import('./claude-credential');

function setRow(kind: Row['kind'], credential: object, expiresAt: Date | null = null) {
	row = {
		id: 'claude-1',
		userId: 'user-1',
		kind,
		credential: encryptSecret(JSON.stringify(credential)).unwrap(),
		expiresAt,
		failedAt: null,
		failure: null,
		usageFiveHourUtilization: null,
		usageFiveHourResetsAt: null,
		usageSevenDayUtilization: null,
		usageSevenDayResetsAt: null,
		usageReadAt: null,
		createdAt: new Date('2026-11-01T00:00:00Z'),
		updatedAt: new Date('2026-11-01T00:00:00Z'),
	};
}

const now = new Date('2026-11-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	mock.clearAllMocks();
	row = null;
});

describe('claudeCredentialFor', () => {
	test('null for a member who connected none', async () => {
		expect((await claudeCredentialFor('user-1', now)).unwrap()).toBeNull();
	});

	test('a token and an API key are handed out as stored, decrypted', async () => {
		setRow('setup_token', {token: 'sk-ant-oat01-abc'}, new Date(now.getTime() + 300 * DAY));
		expect((await claudeCredentialFor('user-1', now)).unwrap()).toEqual({kind: 'setup_token', token: 'sk-ant-oat01-abc'});

		setRow('api_key', {key: 'sk-ant-api03-abc'});
		expect((await claudeCredentialFor('user-1', now)).unwrap()).toEqual({kind: 'api_key', key: 'sk-ant-api03-abc'});
		expect(markClaudeAccountFailed).not.toHaveBeenCalled();
	});

	test('a token past the end the mint reported is refused, and the account marked so, with the words to connect again', async () => {
		setRow('setup_token', {token: 'sk-ant-oat01-abc'}, new Date(now.getTime() - 1000));

		const error = (await claudeCredentialFor('user-1', now)).unwrapErr();

		expect(error.kind).toBe('unavailable');
		expect('message' in error && error.message).toBe('Your Claude sign-in has run out or was refused. Connect it again on the Account page.');
		expect(row?.failedAt).toBeInstanceOf(Date);
		expect(row?.failure).toContain('Connect it again');
	});

	test('a credential noted as refused or run out is not handed out again, and comes back as what it was noted with, until the member connects again', async () => {
		setRow('api_key', {key: 'sk-ant-api03-abc'});
		(await markClaudeCredentialRefused('user-1')).unwrap();

		const refused = (await claudeCredentialFor('user-1', now)).unwrapErr();

		expect(refused).toEqual({kind: 'unavailable', statusCode: 503, message: 'Your Claude sign-in has run out or was refused. Connect it again on the Account page.'});

		// A token that ran out is marked once, and refused from the note after.
		setRow('setup_token', {token: 'sk-ant-oat01-abc'}, new Date(now.getTime() - 1000));
		markClaudeAccountFailed.mockClear();
		(await claudeCredentialFor('user-1', now)).unwrapErr();
		expect((await claudeCredentialFor('user-1', now)).unwrapErr().kind).toBe('unavailable');
		expect(markClaudeAccountFailed).toHaveBeenCalledTimes(1);

		// Connecting again writes the row anew, the note cleared (@proxy/db/claude-account).
		setRow('api_key', {key: 'sk-ant-api03-new'});
		expect((await claudeCredentialFor('user-1', now)).unwrap()).toEqual({kind: 'api_key', key: 'sk-ant-api03-new'});
	});

	test('a token whose end isn’t known is handed out', async () => {
		setRow('setup_token', {token: 'sk-ant-oat01-abc'}, null);
		expect((await claudeCredentialFor('user-1', now)).unwrap()).toEqual({kind: 'setup_token', token: 'sk-ant-oat01-abc'});
	});
});

describe('markClaudeCredentialRefused', () => {
	test('marks the account failed with the words to connect again', async () => {
		setRow('setup_token', {token: 'sk-ant-oat01-abc'});
		(await markClaudeCredentialRefused('user-1')).unwrap();
		expect(markClaudeAccountFailed).toHaveBeenCalledWith('user-1', expect.stringContaining('Connect it again'));
		expect(row?.failure).toContain('run out or was refused');
	});
});

describe('recordClaudeUsage', () => {
	test('keeps the usage on the account as given', async () => {
		const usage = {fiveHour: {utilization: 0.37, resetsAt: new Date('2026-11-10T15:00:00Z')}, readAt: now};
		(await recordClaudeUsage('user-1', usage)).unwrap();
		expect(setClaudeAccountUsage).toHaveBeenCalledWith('user-1', usage);
	});
});
