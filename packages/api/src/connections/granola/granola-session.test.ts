import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const updateConnectionCredential = mock();

mock.module('@proxy/db/connection', () => ({updateConnectionCredential}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const callGranolaTool = mock();

mock.module('./granola-mcp', () => ({callGranolaTool}));

const refreshGranolaTokens = mock();

// The real expiry check, with refreshing faked.
const oauth = await import('./granola-oauth');
mock.module('./granola-oauth', () => ({...oauth, refreshGranolaTokens}));

const fresh = {clientId: 'client-1', accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: new Date(Date.now() + 3600_000).toISOString()};

function connectionWith(expiresAt: string | null) {
	const credential = {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt};
	return {id: 'granola-1', credential: `enc:${JSON.stringify(credential)}`};
}

beforeEach(() => {
	mock.clearAllMocks();
	refreshGranolaTokens.mockResolvedValue(Ok(fresh));
	updateConnectionCredential.mockResolvedValue(Ok(true));
	callGranolaTool.mockResolvedValue(Ok('answer'));
});

describe('callGranolaToolFor', () => {
	test('calls with the stored token while it lasts', async () => {
		const {callGranolaToolFor} = await import('./granola-session');
		const text = (await callGranolaToolFor(connectionWith(new Date(Date.now() + 3600_000).toISOString()), 'list_meetings', {})).unwrap();

		expect(text).toBe('answer');
		expect(callGranolaTool).toHaveBeenCalledWith('access-1', 'list_meetings', {});
		expect(refreshGranolaTokens).not.toHaveBeenCalled();
	});

	test('refreshes a token about to run out, and saves the new one only over the old', async () => {
		const {callGranolaToolFor} = await import('./granola-session');
		const connection = connectionWith(new Date(Date.now() + 10_000).toISOString());
		await callGranolaToolFor(connection, 'list_meetings', {});

		expect(callGranolaTool).toHaveBeenCalledWith('access-2', 'list_meetings', {});
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'granola-1', credential: `enc:${JSON.stringify(fresh)}`, previous: connection.credential});
	});

	test('refreshes once when Granola turns the token down, then gives up', async () => {
		callGranolaTool.mockResolvedValueOnce(Err(ApiErr.credentialsRejected()));
		const {callGranolaToolFor} = await import('./granola-session');
		expect((await callGranolaToolFor(connectionWith(null), 'list_meetings', {})).unwrap()).toBe('answer');
		expect(callGranolaTool.mock.calls.map((call) => call[0])).toEqual(['access-1', 'access-2']);

		callGranolaTool.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		expect((await callGranolaToolFor(connectionWith(null), 'list_meetings', {})).unwrapErr().kind).toBe('credentials_rejected');
	});

	test('a connection Granola will not refresh any more has to sign in again', async () => {
		refreshGranolaTokens.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callGranolaToolFor} = await import('./granola-session');
		const result = await callGranolaToolFor(connectionWith(new Date(Date.now() - 1000).toISOString()), 'list_meetings', {});

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(callGranolaTool).not.toHaveBeenCalled();
	});
});
