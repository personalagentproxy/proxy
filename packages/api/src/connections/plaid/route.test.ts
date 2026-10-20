import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const findAccountConnection = mock();
const createConnection = mock();
const getConnectionWithCredential = mock();

mock.module('@proxy/db/connection', () => ({
	findAccountConnection,
	createConnection,
	getConnectionWithCredential,
	renewConnection: mock(),
	updateConnectionTools: mock(),
	updateConnectionName: mock(),
}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const env: {PLAID_CLIENT_ID?: string; PLAID_SECRET?: string; PLAID_ENV: string} = {PLAID_ENV: 'sandbox'};

mock.module('../../utils/env', () => ({env}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

type PlaidRequest = {path: string; body: Record<string, unknown>};

const plaid = {requests: [] as PlaidRequest[], accountsStatus: 200};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	plaid.requests.push({path: url.pathname, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>});
	if (url.pathname === '/link/token/create') {
		return Response.json({link_token: 'link-sandbox-1', expiration: '2026-10-15T18:00:00Z'});
	}
	if (url.pathname === '/item/public_token/exchange') {
		return Response.json({access_token: 'access-sandbox-1', item_id: 'item-1'});
	}
	if (url.pathname === '/item/remove') {
		return Response.json({request_id: 'request-1'});
	}
	if (url.pathname === '/accounts/get' && plaid.accountsStatus === 200) {
		return Response.json({accounts: [], item: {item_id: 'item-1', institution_id: 'ins_1', institution_name: 'First Platypus Bank'}});
	}
	return Response.json({error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR'}, {status: 500});
}) as typeof fetch);

const bankRow = {
	id: 'bank-1',
	integrationId: 'plaid',
	account: 'First Platypus Bank',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: null,
	name: null,
	defaults: [],
	credential: 'enc:{"accessToken":"access-sandbox-1","itemId":"item-1"}',
};

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1', email: 'alex@example.com', experiments: []}, params: {}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	plaid.requests = [];
	plaid.accountsStatus = 200;
	env.PLAID_CLIENT_ID = 'plaid-client';
	env.PLAID_SECRET = 'plaid-secret';
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	findAccountConnection.mockResolvedValue(Ok(null));
	createConnection.mockImplementation(async (data: {account: string}) => Ok({...bankRow, account: data.account}));
	getConnectionWithCredential.mockResolvedValue(Ok(bankRow));
});

describe('handleCreatePlaidLinkTokenRoute', () => {
	test('a new bank asks for two years of transactions, for the person signed in', async () => {
		const {handleCreatePlaidLinkTokenRoute} = await import('./route');
		const result = await handleCreatePlaidLinkTokenRoute(makeRequest({}));

		expect(result.unwrap()).toEqual({linkToken: 'link-sandbox-1'});
		expect(plaid.requests).toEqual([
			{
				path: '/link/token/create',
				body: {
					client_name: 'Personal Agent Proxy',
					language: 'en',
					country_codes: ['US', 'CA'],
					user: {client_user_id: 'user-1'},
					products: ['transactions'],
					transactions: {days_requested: 730},
				},
			},
		]);
	});

	test('signing in to a connected bank again is update mode on its login', async () => {
		const {handleCreatePlaidLinkTokenRoute} = await import('./route');
		await handleCreatePlaidLinkTokenRoute(makeRequest({connectionId: 'bank-1'}));

		expect(getConnectionWithCredential).toHaveBeenCalledWith('org-1', 'bank-1');
		expect(plaid.requests[0]?.body).toMatchObject({access_token: 'access-sandbox-1', update: {account_selection_enabled: true}});
		expect(plaid.requests[0]?.body).not.toHaveProperty('products');
	});

	test('only a bank of the organization’s is signed in to again', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...bankRow, integrationId: 'email'}));
		const {handleCreatePlaidLinkTokenRoute} = await import('./route');

		expect((await handleCreatePlaidLinkTokenRoute(makeRequest({connectionId: 'bank-1'}))).unwrapErr().kind).toBe('not_found');
		expect(plaid.requests).toEqual([]);
	});

	test('says so when the server has no Plaid keys', async () => {
		env.PLAID_CLIENT_ID = undefined;
		const {handleCreatePlaidLinkTokenRoute} = await import('./route');
		const error = (await handleCreatePlaidLinkTokenRoute(makeRequest({}))).unwrapErr();

		expect(error).toMatchObject({kind: 'validation_error', message: 'Plaid isn’t set up on this server: PLAID_CLIENT_ID and PLAID_SECRET are missing'});
	});
});

describe('handleConnectPlaidRoute', () => {
	test('exchanges the public token and keeps the login as a connection named by its bank, giving agents nothing yet', async () => {
		const {handleConnectPlaidRoute} = await import('./route');
		const connection = (await handleConnectPlaidRoute(makeRequest({publicToken: 'public-sandbox-1'}))).unwrap();

		expect(plaid.requests.map((request) => [request.path, request.body])).toEqual([
			['/item/public_token/exchange', {public_token: 'public-sandbox-1'}],
			['/accounts/get', {access_token: 'access-sandbox-1'}],
		]);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			integrationId: 'plaid',
			account: 'First Platypus Bank',
			providerAccountId: 'item-1',
			credential: 'enc:{"accessToken":"access-sandbox-1","itemId":"item-1"}',
			defaults: [],
		});
		expect(connection).toMatchObject({integrationId: 'plaid', account: 'First Platypus Bank', defaults: [], unavailable: []});
	});

	test('keeps a login Plaid made even when its bank’s name can’t be read', async () => {
		plaid.accountsStatus = 500;
		const {handleConnectPlaidRoute} = await import('./route');

		expect((await handleConnectPlaidRoute(makeRequest({publicToken: 'public-sandbox-1'}))).unwrap().account).toBe('Bank');
	});

	test('removes the login at Plaid when the connection can’t be saved, so nothing is billed for it', async () => {
		createConnection.mockResolvedValue(Err(ApiErr.dbError(new Error('db down'))));
		const {handleConnectPlaidRoute} = await import('./route');

		expect((await handleConnectPlaidRoute(makeRequest({publicToken: 'public-sandbox-1'}))).isErr()).toBe(true);
		expect(plaid.requests.at(-1)).toEqual({path: '/item/remove', body: {access_token: 'access-sandbox-1'}});
	});

	test('needs the public token', async () => {
		const {handleConnectPlaidRoute} = await import('./route');

		expect((await handleConnectPlaidRoute(makeRequest({}))).unwrapErr().kind).toBe('parse_error');
		expect(plaid.requests).toEqual([]);
	});
});
