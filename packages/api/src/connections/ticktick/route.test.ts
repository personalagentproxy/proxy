import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const checkToken = mock();

mock.module('./ticktick-api', () => ({checkToken}));

const encryptSecret = mock((plaintext: string): Result<string, ApiError> => Ok(`encrypted:${plaintext}`));

mock.module('../../utils/secret-crypto', () => ({encryptSecret}));

const createdRow = {
	id: 'conn-1',
	integrationId: 'ticktick',
	account: 'alex@example.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	defaults: [{actionId: 'read'}],
};

const body = {account: 'alex@example.com', token: 'tp_0123456789abcdef'};

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params: {}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok(createdRow));
	checkToken.mockResolvedValue(Ok(undefined));
});

describe('handleConnectTickTickRoute', () => {
	test('checks the token first, then stores it encrypted with reading on by default', async () => {
		const {handleConnectTickTickRoute} = await import('./route');
		const result = await handleConnectTickTickRoute(makeRequest({account: ' alex@example.com ', token: ' tp_0123456789abcdef\n'}));

		expect(checkToken).toHaveBeenCalledWith('tp_0123456789abcdef');
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			integrationId: 'ticktick',
			account: 'alex@example.com',
			credential: `encrypted:${JSON.stringify({token: 'tp_0123456789abcdef'})}`,
			defaults: ['read'],
		});
		expect(result.unwrap()).toEqual({id: 'conn-1', integrationId: 'ticktick', account: 'alex@example.com', defaults: ['read']});
	});

	test('saves nothing when TickTick turns the token down', async () => {
		const {handleConnectTickTickRoute} = await import('./route');
		checkToken.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const result = await handleConnectTickTickRoute(makeRequest(body));

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});

	test('an account is connected once by its name', async () => {
		const {handleConnectTickTickRoute} = await import('./route');
		listConnections.mockResolvedValue(Ok([{id: 'conn-0', integrationId: 'ticktick', account: 'alex@example.com', defaults: []}]));

		expect((await handleConnectTickTickRoute(makeRequest(body))).unwrapErr().kind).toBe('conflict');
		expect((await handleConnectTickTickRoute(makeRequest({...body, account: 'work'}))).isOk()).toBe(true);
	});

	test('refuses an empty name, and a token that is empty or has spaces in it', async () => {
		const {handleConnectTickTickRoute} = await import('./route');
		for (const bad of [{account: ' '}, {token: ''}, {token: 'tp_one two'}, {token: 42}]) {
			expect((await handleConnectTickTickRoute(makeRequest({...body, ...bad}))).unwrapErr().statusCode, JSON.stringify(bad)).toBe(400);
		}
		expect(checkToken).not.toHaveBeenCalled();
	});
});

describe('handleTestTickTickRoute', () => {
	test('checks the token and saves nothing', async () => {
		const {handleTestTickTickRoute} = await import('./route');
		expect((await handleTestTickTickRoute(makeRequest(body))).isOk()).toBe(true);
		expect(checkToken).toHaveBeenCalledWith('tp_0123456789abcdef');
		expect(createConnection).not.toHaveBeenCalled();

		checkToken.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('timeout'))));
		expect((await handleTestTickTickRoute(makeRequest(body))).unwrapErr().kind).toBe('provider_unreachable');
	});
});
