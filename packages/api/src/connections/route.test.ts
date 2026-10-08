import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const listConnections = mock();
const getConnection = mock();
const deleteConnection = mock();
const setConnectionDefaults = mock();

mock.module('@proxy/db/connection', () => ({
	listConnections,
	getConnection,
	deleteConnection,
	setConnectionDefaults,
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const emailRow = {
	id: 'conn-1',
	integrationId: 'email',
	account: 'alex@example.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	defaults: [{actionId: 'read'}],
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
	setConnectionDefaults.mockResolvedValue(Ok(undefined));
});

describe('handleListConnectionsRoute', () => {
	test("lists the organization's connections with their default actions", async () => {
		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(listConnections).toHaveBeenCalledWith('org-1');
		const [connection] = result.unwrap().connections;
		expect(connection).toMatchObject({id: 'conn-1', integrationId: 'email', account: 'alex@example.com'});
		expect(connection?.defaults).toEqual(['read']);
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
