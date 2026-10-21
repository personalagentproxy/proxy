import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const getAccounts = mock();
const getTransactions = mock();

mock.module('../connections/plaid/plaid-api', () => ({getAccounts, getTransactions}));
mock.module('../connections/plaid/plaid-client', () => ({
	callPlaid: (connection: {credential: string}, call: (client: unknown, accessToken: string) => unknown) => call({}, connection.credential),
}));
mock.module('./sources', () => ({
	findSources: async () => Ok([{connection: {id: 'bank-1', integrationId: 'plaid', account: 'First Platypus Bank', name: null, credential: 'access-1'}, integration: {id: 'plaid'}}]),
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
}));
mock.module('../utils/user-org', () => ({requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1'}), requireUserOrgId: async () => Ok('org-1')}));

const CHECKING = {
	account_id: 'checking',
	name: 'Plaid Checking',
	mask: '0000',
	type: 'depository',
	subtype: 'checking',
	balances: {current: 110, available: 100, limit: null, iso_currency_code: 'USD'},
};

const CARD = {
	account_id: 'card',
	name: 'Plaid Credit Card',
	mask: '3333',
	type: 'credit',
	subtype: 'credit card',
	balances: {current: 410, available: null, limit: 2000, iso_currency_code: 'USD'},
};

const UBER = {
	transaction_id: 'uber',
	account_id: 'checking',
	amount: 5.4,
	iso_currency_code: 'USD',
	date: '2026-10-11',
	name: 'Uber 063015 SF**POOL**',
	merchant_name: 'Uber',
	pending: false,
	personal_finance_category: {primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'},
};

const PAYROLL = {
	transaction_id: 'payroll',
	account_id: 'checking',
	amount: -2500,
	iso_currency_code: 'USD',
	date: '2026-10-10',
	name: 'ACME PAYROLL',
	merchant_name: null,
	pending: true,
	personal_finance_category: null,
};

function request(query: Record<string, string> = {}) {
	return {user: {userId: 'user-1'}, query} as never;
}

beforeEach(() => {
	getAccounts.mockReset();
	getTransactions.mockReset();
	getAccounts.mockResolvedValue(Ok({accounts: [CHECKING, CARD], institution: 'First Platypus Bank'}));
	getTransactions.mockResolvedValue(Ok({accounts: [CHECKING, CARD], transactions: [UBER, PAYROLL], total: 2}));
});

describe('handleBankAccountsRoute', () => {
	test('answers each account with its balances as numbers, a card’s as owed', async () => {
		const {handleBankAccountsRoute} = await import('./bank');
		const answer = (await handleBankAccountsRoute(request())).unwrap();

		expect(answer.sources.map((source) => source.connectionId)).toEqual(['bank-1']);
		expect(answer.accounts).toEqual([
			{connectionId: 'bank-1', id: 'checking', name: 'Plaid Checking', type: 'Checking', mask: '0000', owed: false, balance: 110, available: 100, limit: null, currency: 'USD'},
			{connectionId: 'bank-1', id: 'card', name: 'Plaid Credit Card', type: 'Credit card', mask: '3333', owed: true, balance: 410, available: null, limit: 2000, currency: 'USD'},
		]);
		expect(getAccounts).toHaveBeenCalledWith({}, 'access-1');
	});

	test('a bank that can’t be read is a failure beside the rest', async () => {
		getAccounts.mockResolvedValue(Err(ApiErr.validationError('The bank needs its login again')));
		const {handleBankAccountsRoute} = await import('./bank');
		const answer = (await handleBankAccountsRoute(request())).unwrap();

		expect(answer.accounts).toEqual([]);
		expect(answer.failed).toEqual([{connectionId: 'bank-1', account: 'First Platypus Bank', message: 'The bank needs its login again'}]);
	});
});

describe('handleBankTransactionsRoute', () => {
	test('reads the days asked for, signing amounts as a statement does, with the accounts they are on', async () => {
		const {handleBankTransactionsRoute} = await import('./bank');
		const answer = (await handleBankTransactionsRoute(request({from: '2026-10-01', to: '2026-10-19'}))).unwrap();

		expect(getTransactions).toHaveBeenCalledWith({}, 'access-1', {from: '2026-10-01', to: '2026-10-19', accountId: null, count: 500, offset: 0});
		expect(answer.transactions).toEqual([
			{
				connectionId: 'bank-1',
				accountId: 'checking',
				id: 'uber',
				date: '2026-10-11',
				name: 'Uber 063015 SF**POOL**',
				merchant: 'Uber',
				amount: -5.4,
				currency: 'USD',
				category: 'TRANSPORTATION',
				pending: false,
			},
			{connectionId: 'bank-1', accountId: 'checking', id: 'payroll', date: '2026-10-10', name: 'ACME PAYROLL', merchant: null, amount: 2500, currency: 'USD', category: null, pending: true},
		]);
		expect(answer.accounts.map((account) => account.id)).toEqual(['checking', 'card']);
		expect(answer.more).toBe(false);
	});

	test('reads on from where a page ended, up to three pages, and says when there were more', async () => {
		getTransactions.mockResolvedValue(Ok({accounts: [CHECKING], transactions: [UBER], total: 5}));
		const {handleBankTransactionsRoute} = await import('./bank');
		const answer = (await handleBankTransactionsRoute(request({from: '2026-10-01', to: '2026-10-19'}))).unwrap();

		expect(getTransactions.mock.calls.map((call) => (call[2] as {offset: number}).offset)).toEqual([0, 1, 2]);
		expect(answer.transactions).toHaveLength(3);
		expect(answer.more).toBe(true);
	});

	test('refuses days that aren’t, a range going backwards, and one past two years', async () => {
		const {handleBankTransactionsRoute} = await import('./bank');

		for (const query of [
			{from: '2026-02-30', to: '2026-03-01'},
			{from: '2026-10-19', to: '2026-10-01'},
			{from: '2024-01-01', to: '2026-10-19'},
			{from: 'yesterday', to: 'today'},
		]) {
			const kind = (await handleBankTransactionsRoute(request(query))).unwrapErr().kind;
			expect(['parse_error', 'validation_error']).toContain(kind);
		}
		expect(getTransactions).not.toHaveBeenCalled();
	});
});
