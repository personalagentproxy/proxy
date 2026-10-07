import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const listConnections = mock();
const getConnection = mock();
const deleteConnection = mock();
const setConnectionDefault = mock();

mock.module('@proxy/db/connection', () => ({
	listConnections,
	getConnection,
	deleteConnection,
	setConnectionDefault,
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const emailRow = {
	id: 'conn-1',
	integrationId: 'email',
	account: 'alex@example.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	defaults: [{collectionId: 'emails', access: 'read'}],
};

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {
		user: {userId: 'user-1', email: 'alex@example.com'},
		params,
		body,
	} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([emailRow]));
	getConnection.mockResolvedValue(Ok(emailRow));
	deleteConnection.mockResolvedValue(Ok(true));
	setConnectionDefault.mockResolvedValue(Ok(undefined));
});

describe('handleListConnectionsRoute', () => {
	test("lists the organization's connections with the provider's access and the defaults", async () => {
		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(listConnections).toHaveBeenCalledWith('org-1');
		const [connection] = result.unwrap().connections;
		expect(connection).toMatchObject({id: 'conn-1', integrationId: 'email', account: 'alex@example.com', connectedAt: '2026-10-01T00:00:00.000Z'});
		expect(connection?.collections).toEqual([
			{id: 'emails', provider: 'read', connectionDefault: 'read'},
			{id: 'drafts', provider: 'write', connectionDefault: 'none'},
			{id: 'sent', provider: 'write', connectionDefault: 'none'},
		]);
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

		expect(getConnection).toHaveBeenCalledWith('org-1', 'conn-1');
		expect(result.unwrap().id).toBe('conn-1');
	});

	test('an unknown connection is not found', async () => {
		getConnection.mockResolvedValue(Ok(null));

		const {handleGetConnectionRoute} = await import('./route');
		const result = await handleGetConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleDeleteConnectionRoute', () => {
	test('deletes the connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(deleteConnection).toHaveBeenCalledWith('org-1', 'conn-1');
		expect(result.isOk()).toBe(true);
	});

	test('Information is built in and stays', async () => {
		getConnection.mockResolvedValue(Ok({...emailRow, integrationId: 'info'}));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(deleteConnection).not.toHaveBeenCalled();
	});

	test('an unknown connection is not found', async () => {
		getConnection.mockResolvedValue(Ok(null));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleSetConnectionDefaultRoute', () => {
	test('stores a default the provider allows', async () => {
		const {handleSetConnectionDefaultRoute} = await import('./route');
		const result = await handleSetConnectionDefaultRoute(makeRequest({connectionId: 'conn-1', collectionId: 'drafts'}, {access: 'write'}));

		expect(setConnectionDefault).toHaveBeenCalledWith({connectionId: 'conn-1', collectionId: 'drafts', access: 'write'});
		expect(result.isOk()).toBe(true);
	});

	test('refuses a default above what the provider allows', async () => {
		const {handleSetConnectionDefaultRoute} = await import('./route');
		const result = await handleSetConnectionDefaultRoute(makeRequest({connectionId: 'conn-1', collectionId: 'emails'}, {access: 'write'}));

		expect(result.unwrapErr().kind).toBe('conflict');
		expect(setConnectionDefault).not.toHaveBeenCalled();
	});

	test('refuses a collection the integration does not have', async () => {
		const {handleSetConnectionDefaultRoute} = await import('./route');
		const result = await handleSetConnectionDefaultRoute(makeRequest({connectionId: 'conn-1', collectionId: 'events'}, {access: 'read'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});

	test('refuses an unknown access level', async () => {
		const {handleSetConnectionDefaultRoute} = await import('./route');
		const result = await handleSetConnectionDefaultRoute(makeRequest({connectionId: 'conn-1', collectionId: 'drafts'}, {access: 'admin'}));

		expect(result.unwrapErr().kind).toBe('parse_error');
	});

	test('propagates db errors', async () => {
		setConnectionDefault.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleSetConnectionDefaultRoute} = await import('./route');
		const result = await handleSetConnectionDefaultRoute(makeRequest({connectionId: 'conn-1', collectionId: 'drafts'}, {access: 'read'}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});
