import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {McpServer} from './mcp-oauth';

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

const callMcpTool = mock();

mock.module('./mcp-client', () => ({callMcpTool}));

const refreshMcpTokens = mock();

// The real expiry check, with refreshing faked.
const oauth = await import('./mcp-oauth');
mock.module('./mcp-oauth', () => ({...oauth, refreshMcpTokens}));

const SERVER: McpServer = {
	name: 'Example',
	url: 'https://mcp.example.com/mcp',
	registerUrl: 'https://mcp.example.com/register',
	authorizeUrl: 'https://mcp.example.com/authorize',
	tokenUrl: 'https://mcp.example.com/token',
	scope: 'default',
};

const fresh = {clientId: 'client-1', accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: new Date(Date.now() + 3600_000).toISOString()};

function connectionWith(expiresAt: string | null) {
	const credential = {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt};
	return {id: 'conn-1', credential: `enc:${JSON.stringify(credential)}`};
}

beforeEach(() => {
	mock.clearAllMocks();
	refreshMcpTokens.mockResolvedValue(Ok(fresh));
	updateConnectionCredential.mockResolvedValue(Ok(true));
	callMcpTool.mockResolvedValue(Ok('answer'));
});

describe('callMcpToolFor', () => {
	test('calls with the stored token while it lasts', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const text = (await callMcpToolFor(SERVER, connectionWith(new Date(Date.now() + 3600_000).toISOString()), 'list_meetings', {})).unwrap();

		expect(text).toBe('answer');
		expect(callMcpTool).toHaveBeenCalledWith(SERVER, 'access-1', 'list_meetings', {});
		expect(refreshMcpTokens).not.toHaveBeenCalled();
	});

	test('refreshes a token about to run out, and saves the new one only over the old', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const connection = connectionWith(new Date(Date.now() + 10_000).toISOString());
		await callMcpToolFor(SERVER, connection, 'list_meetings', {});

		expect(callMcpTool).toHaveBeenCalledWith(SERVER, 'access-2', 'list_meetings', {});
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'conn-1', credential: `enc:${JSON.stringify(fresh)}`, previous: connection.credential});
	});

	test('calls at once on a running-out token share one refresh', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const connection = connectionWith(new Date(Date.now() + 10_000).toISOString());
		await Promise.all([callMcpToolFor(SERVER, connection, 'a', {}), callMcpToolFor(SERVER, connection, 'b', {})]);

		expect(refreshMcpTokens).toHaveBeenCalledTimes(1);
		expect(callMcpTool.mock.calls.map((call) => call[1])).toEqual(['access-2', 'access-2']);
	});

	test('refreshes once when the server turns the token down, then gives up', async () => {
		callMcpTool.mockResolvedValueOnce(Err(ApiErr.credentialsRejected()));
		const {callMcpToolFor} = await import('./mcp-session');
		expect((await callMcpToolFor(SERVER, connectionWith(null), 'list_meetings', {})).unwrap()).toBe('answer');
		expect(callMcpTool.mock.calls.map((call) => call[1])).toEqual(['access-1', 'access-2']);

		callMcpTool.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		expect((await callMcpToolFor(SERVER, connectionWith(null), 'list_meetings', {})).unwrapErr().kind).toBe('credentials_rejected');
	});

	test('a connection the server will not refresh any more has to sign in again', async () => {
		refreshMcpTokens.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callMcpToolFor} = await import('./mcp-session');
		const result = await callMcpToolFor(SERVER, connectionWith(new Date(Date.now() - 1000).toISOString()), 'list_meetings', {});

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(callMcpTool).not.toHaveBeenCalled();
	});
});
