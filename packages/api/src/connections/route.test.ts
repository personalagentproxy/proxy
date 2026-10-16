import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findIntegration} from '@proxy/integrations';

const listConnectionsWithCredential = mock();
const getConnectionWithCredential = mock();
const deleteConnection = mock();
const setConnectionDefaults = mock();
const updateConnectionName = mock();
const countSameAccountConnections = mock();

mock.module('@proxy/db/connection', () => ({
	listConnectionsWithCredential,
	getConnectionWithCredential,
	deleteConnection,
	setConnectionDefaults,
	updateConnectionName,
	countSameAccountConnections,
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const warn = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn, error: mock()},
	serializeError: mock(() => ({})),
}));

// Readable stand-ins for encryption, so a test can write the credential it means.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

mock.module('../utils/env', () => ({env: {PLAID_CLIENT_ID: 'plaid-client', PLAID_SECRET: 'plaid-secret', PLAID_ENV: 'sandbox'}}));

// Google's revoke endpoint and Plaid's: each request, and its answer.
const google = {requests: [] as Array<{url: string; body: URLSearchParams; text: string}>, status: 200};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const text = typeof init?.body === 'string' ? init.body : '';
	google.requests.push({url, body: new URLSearchParams(text), text});
	return new Response(google.status === 200 ? '{}' : '{"error":"invalid_token"}', {status: google.status});
}) as typeof fetch);

const emailRow = {
	id: 'conn-1',
	integrationId: 'email',
	account: 'alex@example.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: null,
	name: null,
	defaults: [{actionId: 'read'}],
	credential: 'enc:{}',
};

function googleRow(scopes: string[]) {
	const credential = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes, email: 'alex@example.com'};
	return {...emailRow, id: 'conn-2', integrationId: 'google', defaults: [], credential: `enc:${JSON.stringify(credential)}`};
}

// The person unticked Drive on Google's consent screen.
const withoutDrive = googleRow([
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/contacts',
]);

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {
		user: {userId: 'user-1', email: 'alex@example.com'},
		params,
		body,
	} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	google.requests = [];
	google.status = 200;
	countSameAccountConnections.mockResolvedValue(Ok(1));
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnectionsWithCredential.mockResolvedValue(Ok([emailRow]));
	getConnectionWithCredential.mockResolvedValue(Ok(emailRow));
	deleteConnection.mockResolvedValue(Ok(true));
	setConnectionDefaults.mockResolvedValue(Ok(undefined));
});

describe('handleListConnectionsRoute', () => {
	test("lists the organization's connections with their default actions", async () => {
		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(listConnectionsWithCredential).toHaveBeenCalledWith('org-1');
		const [connection] = result.unwrap().connections;
		expect(connection).toMatchObject({id: 'conn-1', integrationId: 'email', account: 'alex@example.com'});
		expect(connection?.defaults).toEqual(['read']);
		expect(connection?.unavailable).toEqual([]);
	});

	test("a Google credential that can't be read leaves the rest listed, itself with no action available", async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([emailRow, {...googleRow([]), credential: 'v1.other-key'}]));
		const {handleListConnectionsRoute} = await import('./route');
		const {connections} = (await handleListConnectionsRoute(makeRequest())).unwrap();

		const every = findIntegration('google')?.actions.map((action) => action.id);
		expect(connections.map((connection) => [connection.id, connection.unavailable])).toEqual([
			['conn-1', []],
			['conn-2', every ?? []],
		]);
	});

	test("says which actions a Google connection's sign-in didn't cover, never the credential", async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([emailRow, withoutDrive]));

		const {handleListConnectionsRoute} = await import('./route');
		const [, connection] = (await handleListConnectionsRoute(makeRequest())).unwrap().connections;

		expect(connection).toEqual({
			id: 'conn-2',
			integrationId: 'google',
			account: 'alex@example.com',
			defaults: [],
			tools: null,
			name: null,
			unavailable: ['readFiles', 'createFiles', 'editFiles', 'trashFiles'],
		});
	});

	test('a user without an organization is signed out', async () => {
		getUserOrgId.mockResolvedValue(Ok(null));

		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(result.unwrapErr().kind).toBe('unauthenticated');
	});
});

describe('handleGetConnectionRoute', () => {
	test("looks the connection up in the user's organization", async () => {
		const {handleGetConnectionRoute} = await import('./route');
		const result = await handleGetConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(getConnectionWithCredential).toHaveBeenCalledWith('org-1', 'conn-1');
		expect(result.unwrap().id).toBe('conn-1');
	});

	test('an unknown connection is not found', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));

		const {handleGetConnectionRoute} = await import('./route');
		const result = await handleGetConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleRenameConnectionRoute', () => {
	test('renames the connection, an empty name being none of its own', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		const {handleRenameConnectionRoute} = await import('./route');
		const renamed = (await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ' Work mail '}))).unwrap();
		expect(updateConnectionName).toHaveBeenCalledWith({connectionId: 'conn-1', name: 'Work mail'});
		expect(renamed.name).toBe('Work mail');

		const cleared = (await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ''}))).unwrap();
		expect(updateConnectionName).toHaveBeenLastCalledWith({connectionId: 'conn-1', name: null});
		expect(cleared.name).toBeNull();
	});

	test('a custom MCP server needs a name, and Information keeps its own', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'mcp', tools: '[]', name: 'Docs'}));
		const {handleRenameConnectionRoute} = await import('./route');
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ' '}))).unwrapErr().kind).toBe('validation_error');

		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'info'}));
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Mine'}))).unwrapErr().kind).toBe('forbidden');
		expect(updateConnectionName).not.toHaveBeenCalled();
	});
});

describe('handleDeleteConnectionRoute', () => {
	test('deletes the connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-1');
		expect(result.isOk()).toBe(true);
	});

	test('revokes a Google connection at Google first, its refresh token ending the whole grant', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(google.requests.map(({url, body}) => [url, body.get('token')])).toEqual([['https://oauth2.googleapis.com/revoke', 'refresh-1']]);
		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-2');
	});

	test('keeps the grant at Google while another connection, in any organization, is for the same account', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));
		countSameAccountConnections.mockResolvedValue(Ok(2));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(countSameAccountConnections).toHaveBeenCalledWith('conn-2');
		expect(google.requests).toEqual([]);
		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-2');
	});

	test('deletes a Google connection even when Google turns the revoke down', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));
		google.status = 400;

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-2');
	});

	test('removes a bank login at Plaid first, which ends what Plaid bills for it', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, id: 'conn-3', integrationId: 'plaid', credential: 'enc:{"accessToken":"access-sandbox-1","itemId":"item-1"}'}));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-3'}));

		expect(result.isOk()).toBe(true);
		expect(google.requests.map(({url, text}) => [url, JSON.parse(text)])).toEqual([['https://sandbox.plaid.com/item/remove', {access_token: 'access-sandbox-1'}]]);
		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-3');
	});

	test('asks nothing of the provider for any other connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(google.requests).toEqual([]);
	});

	test('Information is built in and stays', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'info'}));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(deleteConnection).not.toHaveBeenCalled();
	});

	test('an unknown connection is not found', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleSetConnectionDefaultsRoute', () => {
	test('turns default actions on and off', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: true, send: false}}));

		expect(setConnectionDefaults).toHaveBeenCalledWith({connectionId: 'conn-1', actions: {read: true, send: false}});
		expect(result.isOk()).toBe(true);
	});

	test('refuses an action the integration does not have', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {readCards: true}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(setConnectionDefaults).not.toHaveBeenCalled();
	});

	test("refuses turning on an action the sign-in didn't cover, saying how to allow it", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-2'}, {actions: {readFiles: true}}));

		expect(result.unwrapErr()).toMatchObject({kind: 'validation_error', message: "Google didn't allow Read files at sign-in. Sign in to Google again to allow it."});
		expect(setConnectionDefaults).not.toHaveBeenCalled();
	});

	test("turns off an action the sign-in didn't cover", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-2'}, {actions: {readFiles: false}}));

		expect(result.unwrap().unavailable).toEqual(['readFiles', 'createFiles', 'editFiles', 'trashFiles']);
		expect(setConnectionDefaults).toHaveBeenCalledWith({connectionId: 'conn-2', actions: {readFiles: false}});
	});

	test('refuses a setting that is not on or off', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: null}}));

		expect(result.unwrapErr().kind).toBe('parse_error');
	});

	test('propagates db errors', async () => {
		setConnectionDefaults.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: true}}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});
