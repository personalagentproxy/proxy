import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {McpServer} from './mcp-oauth';

const updateConnectionCredential = mock();

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential, getConnectionCredential: mock(async () => Ok(null))}));

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
	const credential = {auth: 'oauth', clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt};
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
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'conn-1', credential: `enc:${JSON.stringify({auth: 'oauth', ...fresh})}`, previous: connection.credential});
	});

	test('tokens stored bare, as before every MCP credential said how it signs in, are read, and saved in the shape they have now', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const bare = {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 10_000).toISOString()};
		const connection = {id: 'conn-1', credential: `enc:${JSON.stringify(bare)}`};
		await callMcpToolFor(SERVER, connection, 'list_meetings', {});

		expect(refreshMcpTokens).toHaveBeenCalledWith(SERVER, {auth: 'oauth', ...bare});
		expect(updateConnectionCredential.mock.calls[0]?.[0]).toMatchObject({credential: `enc:${JSON.stringify({auth: 'oauth', ...fresh})}`});
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

	test('a custom server’s sign-in keeps its address beside the new tokens', async () => {
		const {withMcpSignIn} = await import('./mcp-session');
		const {oauthAuthSchema} = await import('./mcp-credential');
		const credential = {
			auth: 'oauth',
			url: 'https://mcp.example.com/mcp',
			clientId: 'client-1',
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: new Date(Date.now() + 10_000).toISOString(),
		};
		const connection = {id: 'conn-1', credential: `enc:${JSON.stringify(credential)}`};
		await withMcpSignIn(SERVER, connection, oauthAuthSchema.extend({url: z.string()}), (accessToken) => callMcpTool(SERVER, accessToken, 'search', {}));

		const saved = updateConnectionCredential.mock.calls[0]?.[0] as {credential: string};
		expect(JSON.parse(saved.credential.replace(/^enc:/, ''))).toEqual({auth: 'oauth', url: 'https://mcp.example.com/mcp', ...fresh});
	});

	test('a connection the server will not refresh any more has to sign in again', async () => {
		refreshMcpTokens.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callMcpToolFor} = await import('./mcp-session');
		const result = await callMcpToolFor(SERVER, connectionWith(new Date(Date.now() - 1000).toISOString()), 'list_meetings', {});

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(callMcpTool).not.toHaveBeenCalled();
	});
});

describe('callMcpToolFor with an API key', () => {
	const connection = {id: 'conn-2', credential: `enc:${JSON.stringify({auth: 'token', token: 'exa-key-1'})}`};

	test('a key stored as before, `{auth: "key"}`, is sent as it is', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const legacy = {id: 'conn-2', credential: `enc:${JSON.stringify({auth: 'key', key: 'exa-key-1'})}`};
		expect((await callMcpToolFor(SERVER, legacy, 'web_search_exa', {})).unwrap()).toBe('answer');
		expect(callMcpTool).toHaveBeenCalledWith(SERVER, 'exa-key-1', 'web_search_exa', {});
	});

	test('sends the key as the token, and never refreshes it', async () => {
		const {callMcpToolFor} = await import('./mcp-session');
		const text = (await callMcpToolFor(SERVER, connection, 'web_search_exa', {query: 'bun'})).unwrap();

		expect(text).toBe('answer');
		expect(callMcpTool).toHaveBeenCalledWith(SERVER, 'exa-key-1', 'web_search_exa', {query: 'bun'});
		expect(refreshMcpTokens).not.toHaveBeenCalled();
	});

	test('a key the server turns down is credentials_rejected, nothing refreshed or saved', async () => {
		callMcpTool.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callMcpToolFor} = await import('./mcp-session');
		const error = (await callMcpToolFor(SERVER, connection, 'web_search_exa', {})).unwrapErr();

		expect(error.kind).toBe('credentials_rejected');
		expect(refreshMcpTokens).not.toHaveBeenCalled();
		expect(updateConnectionCredential).not.toHaveBeenCalled();
	});
});
