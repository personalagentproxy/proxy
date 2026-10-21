import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('../utils/env', () => ({env: {PLAID_CLIENT_ID: 'plaid-client', PLAID_SECRET: 'plaid-secret', PLAID_ENV: 'sandbox'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function collection(id: string): Collection {
	const integration = findIntegration('plaid');
	const found = integration && findCollection(integration, id);
	if (!found) {
		throw new Error(`No ${id} collection`);
	}
	return found;
}

function messageOf<T>(result: Result<T, ApiError>): string | null {
	if (result.isOk()) {
		return null;
	}
	return 'message' in result.error ? result.error.message : result.error.kind;
}

const connection = {
	id: 'bank-1',
	integrationId: 'plaid',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	connectedById: 'user-1',
	account: 'First Platypus Bank',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credential: 'enc:{"accessToken":"access-sandbox-1","itemId":"item-1"}',
};

const accounts = {connection, collection: collection('accounts')};
const transactions = {connection, collection: collection('transactions')};

const CHECKING_ID = 'lvo4Kk83g6t5mqDmPJ4DHKbKv43qRruEJPzQE';
const CARD_ID = 'rzoQdxbPXviqo9ZozrQZTN6NjQRxVqfao8W4p';
const UBER_ID = 'k9oaqlgBXvTbAmMANJ9MSo88v1BlPbfLq6N9o';
const PAYROLL_ID = 'Mq7ZdkzGx8sXjLR5pB3nQeVw2cHtYa9uWf4oE';

const CHECKING = {
	account_id: CHECKING_ID,
	name: 'Plaid Checking',
	mask: '0000',
	type: 'depository',
	subtype: 'checking',
	balances: {current: 110, available: 100, limit: null, iso_currency_code: 'USD'},
};

const CARD = {
	account_id: CARD_ID,
	name: 'Plaid Credit Card',
	mask: '3333',
	type: 'credit',
	subtype: 'credit card',
	balances: {current: 410, available: null, limit: 2000, iso_currency_code: 'USD'},
};

const ITEM = {item_id: 'item-1', institution_id: 'ins_109508', institution_name: 'First Platypus Bank'};

const UBER = {
	transaction_id: UBER_ID,
	account_id: CHECKING_ID,
	amount: 5.4,
	iso_currency_code: 'USD',
	date: '2026-10-11',
	name: 'Uber 063015 SF**POOL**',
	merchant_name: 'Uber',
	pending: false,
	personal_finance_category: {primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'},
	location: {city: 'San Francisco', region: 'CA', country: 'US'},
};

const PAYROLL = {
	transaction_id: PAYROLL_ID,
	account_id: CHECKING_ID,
	amount: -2500,
	iso_currency_code: 'USD',
	date: '2026-10-10',
	name: 'ACME PAYROLL',
	merchant_name: null,
	pending: true,
	personal_finance_category: {primary: 'INCOME', detailed: 'INCOME_WAGES'},
	location: {city: null, region: null, country: null},
};

type PlaidRequest = {path: string; body: Record<string, unknown>; headers: Headers};

const plaid = {
	requests: [] as PlaidRequest[],
	total: 2,
	accounts: [CHECKING, CARD] as object[],
	transactions: [UBER, PAYROLL] as object[],
	error: null as null | {status: number; body: object},
};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
	plaid.requests.push({path: url.pathname, body, headers: new Headers(init?.headers)});
	if (plaid.error) {
		return Response.json(plaid.error.body, {status: plaid.error.status});
	}
	if (url.pathname === '/accounts/get') {
		return Response.json({accounts: plaid.accounts, item: ITEM});
	}
	if (url.pathname === '/transactions/get') {
		return Response.json({accounts: [CHECKING, CARD], transactions: plaid.transactions, total_transactions: plaid.total, item: ITEM});
	}
	return new Response('{}', {status: 404});
}) as typeof fetch);

beforeEach(() => {
	plaid.requests = [];
	plaid.total = 2;
	plaid.accounts = [CHECKING, CARD];
	plaid.transactions = [UBER, PAYROLL];
	plaid.error = null;
});

const LIST = {search: null, page: null, filter: null, parent: null};

function tomorrow(): string {
	return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('accounts', () => {
	test('lists each account with its balances, with Plaid’s keys and the bank login’s access token', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		const page = (await plaidConnector.list(accounts, LIST)).unwrap();

		expect(page.nextPage).toBeNull();
		expect(page.records.map((record) => [record.id, record.values])).toEqual([
			[CHECKING_ID, {name: 'Plaid Checking', type: 'Checking', number: '••0000', balance: '110.00 USD', available: '100.00 USD', limit: ''}],
			[CARD_ID, {name: 'Plaid Credit Card', type: 'Credit card', number: '••3333', balance: '410.00 USD', available: '', limit: '2000.00 USD'}],
		]);
		const [request] = plaid.requests;
		expect(request?.path).toBe('/accounts/get');
		expect(request?.body).toEqual({access_token: 'access-sandbox-1'});
		expect(request?.headers.get('plaid-client-id')).toBe('plaid-client');
		expect(request?.headers.get('plaid-secret')).toBe('plaid-secret');
	});

	test('opens one account, and an account the bank login doesn’t have is not found', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		expect((await plaidConnector.get(accounts, CARD_ID)).unwrap().values.limit).toBe('2000.00 USD');
		expect((await plaidConnector.get(accounts, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).unwrapErr().kind).toBe('not_found');
	});

	test('writes an amount with its currency’s own digits, and one without an ISO code with every digit Plaid gives', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		plaid.accounts = [
			{...CHECKING, balances: {current: 15000, available: null, limit: null, iso_currency_code: 'JPY'}},
			{...CARD, balances: {current: 0.00342, available: null, limit: null, iso_currency_code: null, unofficial_currency_code: 'BTC'}},
		];

		expect((await plaidConnector.list(accounts, LIST)).unwrap().records.map((record) => record.values.balance)).toEqual(['15000 JPY', '0.00342 BTC']);
	});

	test('is only read', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		expect(messageOf(await plaidConnector.create(accounts, {}, null))).toBe('Bank accounts are only read here');
		expect(plaid.requests).toEqual([]);
	});
});

describe('transactions', () => {
	test('the top of the tree is the accounts, each holding its transactions', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		const page = (await plaidConnector.list(transactions, LIST)).unwrap();

		expect(page.records.map((record) => [record.id, record.values, record.hasChildren])).toEqual([
			[CHECKING_ID, {name: 'Plaid Checking', kind: 'Account', account: 'Plaid Checking ••0000'}, true],
			[CARD_ID, {name: 'Plaid Credit Card', kind: 'Account', account: 'Plaid Credit Card ••3333'}, true],
		]);
	});

	test('inside an account, its transactions newest first, money out negative and money in positive', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		const page = (await plaidConnector.list(transactions, {...LIST, parent: CHECKING_ID})).unwrap();

		expect(plaid.requests[0]?.body).toEqual({
			access_token: 'access-sandbox-1',
			start_date: '2000-01-01',
			end_date: tomorrow(),
			options: {count: 50, offset: 0, account_ids: [CHECKING_ID]},
		});
		expect(page.trail).toEqual([{id: CHECKING_ID, title: 'Plaid Checking'}]);
		expect(page.nextPage).toBeNull();
		expect(page.records.map((record) => [record.id, record.values])).toEqual([
			[
				`${CHECKING_ID}:2026-10-11:${UBER_ID}`,
				{
					name: 'Uber',
					kind: 'Transaction',
					date: '2026-10-11',
					amount: '-5.40 USD',
					account: 'Plaid Checking ••0000',
					category: 'Transportation: Taxis and ride shares',
					status: 'Posted',
					description: 'Uber 063015 SF**POOL**',
					location: 'San Francisco, CA, US',
				},
			],
			[
				`${CHECKING_ID}:2026-10-10:${PAYROLL_ID}`,
				{
					name: 'ACME PAYROLL',
					kind: 'Transaction',
					date: '2026-10-10',
					amount: '2500.00 USD',
					account: 'Plaid Checking ••0000',
					category: 'Income: Wages',
					status: 'Pending',
					description: 'ACME PAYROLL',
					location: '',
				},
			],
		]);
	});

	test('a page carries the days it covers and goes on from where the last one ended', async () => {
		plaid.total = 120;
		const {plaidConnector} = await import('./plaid-connector');
		const first = (await plaidConnector.list(transactions, {...LIST, parent: CHECKING_ID, search: '2026-09-01 2026-09-30'})).unwrap();
		const next = (await plaidConnector.list(transactions, {...LIST, parent: CHECKING_ID, page: first.nextPage})).unwrap();

		expect(plaid.requests.map((request) => [request.body.start_date, request.body.end_date, request.body.options])).toEqual([
			['2026-09-01', '2026-09-30', {count: 50, offset: 0, account_ids: [CHECKING_ID]}],
			['2026-09-01', '2026-09-30', {count: 50, offset: 2, account_ids: [CHECKING_ID]}],
		]);
		expect(next.nextPage).not.toBeNull();
	});

	test('a search at the top is in every account, a day alone being that day and before it', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		await plaidConnector.list(transactions, {...LIST, search: '2026-09-30'});

		expect(plaid.requests[0]?.body).toMatchObject({start_date: '2000-01-01', end_date: '2026-09-30', options: {count: 50, offset: 0}});
		expect(plaid.requests[0]?.body.options).not.toHaveProperty('account_ids');
	});

	test('a search in words is refused, saying what a search takes', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		expect(messageOf(await plaidConnector.list(transactions, {...LIST, search: 'coffee'}))).toStartWith('Search with a day');
		expect(messageOf(await plaidConnector.list(transactions, {...LIST, search: '2026-02-30'}))).toStartWith('Search with a day');
		expect(messageOf(await plaidConnector.list(transactions, {...LIST, search: '2026-13-01'}))).toStartWith('Search with a day');
		expect(messageOf(await plaidConnector.list(transactions, {...LIST, search: '2026-09-01 2026-02-32'}))).toStartWith('Search with a day');
		expect(plaid.requests).toEqual([]);
	});

	test('a transaction on a day the calendar doesn’t have is not found', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		expect((await plaidConnector.get(transactions, `${CHECKING_ID}:2026-13-01:${UBER_ID}`)).unwrapErr().kind).toBe('not_found');
	});

	test('opens a transaction among its account’s on its day', async () => {
		const {plaidConnector} = await import('./plaid-connector');
		const record = (await plaidConnector.get(transactions, `${CHECKING_ID}:2026-10-11:${UBER_ID}`)).unwrap();

		expect(record.values.amount).toBe('-5.40 USD');
		expect(plaid.requests[0]?.body).toMatchObject({start_date: '2026-10-11', end_date: '2026-10-11', options: {account_ids: [CHECKING_ID]}});
	});

	test('a pending transaction the bank has since posted is not found', async () => {
		plaid.transactions = [UBER];
		const {plaidConnector} = await import('./plaid-connector');

		expect((await plaidConnector.get(transactions, `${CHECKING_ID}:2026-10-10:${PAYROLL_ID}`)).unwrapErr()).toMatchObject({kind: 'not_found', id: `${CHECKING_ID}:2026-10-10:${PAYROLL_ID}`});
	});

	test('a transaction holds nothing, and an account Plaid doesn’t know is not found', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		expect(messageOf(await plaidConnector.list(transactions, {...LIST, parent: `${CHECKING_ID}:2026-10-11:${UBER_ID}`}))).toBe('Transactions hold nothing: give an account’s id as parent');
		plaid.error = {status: 400, body: {error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCOUNT_ID', error_message: 'one or more of the account IDs is invalid'}};
		expect((await plaidConnector.list(transactions, {...LIST, parent: CARD_ID})).unwrapErr()).toMatchObject({kind: 'not_found', id: CARD_ID});
	});
});

describe('Plaid’s errors', () => {
	test('a bank that needs its login again says where the person signs in again', async () => {
		plaid.error = {status: 400, body: {error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed'}};
		const {plaidConnector} = await import('./plaid-connector');

		expect(messageOf(await plaidConnector.list(accounts, LIST))).toContain('Sign in to the bank again');
	});

	test('transactions not fetched yet say to try again shortly', async () => {
		plaid.error = {status: 400, body: {error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY', error_message: 'not ready'}};
		const {plaidConnector} = await import('./plaid-connector');

		expect(messageOf(await plaidConnector.list(transactions, {...LIST, parent: CHECKING_ID}))).toBe('Plaid is still fetching this bank’s transactions. Try again in a minute.');
	});

	test('a login removed at Plaid is turned down, and a bank that is down is out of reach', async () => {
		const {plaidConnector} = await import('./plaid-connector');

		plaid.error = {status: 400, body: {error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN', error_message: 'could not find matching access token'}};
		expect((await plaidConnector.list(accounts, LIST)).unwrapErr().kind).toBe('credentials_rejected');
		plaid.error = {status: 400, body: {error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN', error_message: 'down'}};
		expect((await plaidConnector.list(accounts, LIST)).unwrapErr().kind).toBe('provider_unreachable');
	});
});
