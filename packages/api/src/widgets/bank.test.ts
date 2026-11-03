import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const balances = mock();
const transactionsBetween = mock();

mock.module('./sources', () => ({
	findSources: async () =>
		Ok([
			{connection: {id: 'bank-1', integrationId: 'plaid', account: 'First Platypus Bank', name: null}, connector: {balances, transactionsBetween}},
			// A collection of accounts the widgets can't read.
			{connection: {id: 'other-1', integrationId: 'postgres', account: 'db', name: null}, connector: {}},
		]),
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
	withCapability: (sources: Array<{connector: object}>, capability: string) => sources.filter((source) => capability in source.connector),
}));
mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
}));

const CHECKING = {id: 'checking', name: 'Plaid Checking', type: 'Checking', mask: '0000', owed: false, balance: 110, available: 100, limit: null, currency: 'USD'};
const PAYROLL = {accountId: 'checking', id: 'payroll', date: '2026-10-10', name: 'ACME PAYROLL', merchant: null, amount: 2500, currency: 'USD', category: null, pending: true};
const UBER = {accountId: 'checking', id: 'uber', date: '2026-10-11', name: 'Uber', merchant: 'Uber', amount: -5.4, currency: 'USD', category: 'TRANSPORTATION', pending: false};

function request(query: Record<string, string> = {}) {
	return {user: {userId: 'user-1'}, query} as never;
}

beforeEach(() => {
	balances.mockReset();
	transactionsBetween.mockReset();
	balances.mockResolvedValue(Ok([CHECKING]));
	transactionsBetween.mockResolvedValue(Ok({accounts: [CHECKING], transactions: [PAYROLL, UBER], more: false}));
});

describe('handleBankAccountsRoute', () => {
	test('answers each bank’s accounts, with the connection they are of', async () => {
		const {handleBankAccountsRoute} = await import('./bank');
		const answer = (await handleBankAccountsRoute(request())).unwrap();

		expect(answer.sources.map((source) => source.connectionId)).toEqual(['bank-1']);
		expect(answer.accounts).toEqual([{connectionId: 'bank-1', ...CHECKING}]);
	});

	test('a bank that can’t be read is a failure beside the rest', async () => {
		balances.mockResolvedValue(Err(ApiErr.validationError('The bank needs its login again')));
		const {handleBankAccountsRoute} = await import('./bank');
		const answer = (await handleBankAccountsRoute(request())).unwrap();

		expect(answer.accounts).toEqual([]);
		expect(answer.failed).toEqual([{connectionId: 'bank-1', account: 'First Platypus Bank', message: 'The bank needs its login again'}]);
	});
});

describe('handleBankTransactionsRoute', () => {
	test('reads the days asked for, newest first, with the accounts they are on and whether there were more', async () => {
		transactionsBetween.mockResolvedValue(Ok({accounts: [CHECKING], transactions: [PAYROLL, UBER], more: true}));
		const {handleBankTransactionsRoute} = await import('./bank');
		const answer = (await handleBankTransactionsRoute(request({from: '2026-10-01', to: '2026-10-19'}))).unwrap();

		expect(transactionsBetween).toHaveBeenCalledWith(expect.anything(), {from: '2026-10-01', to: '2026-10-19'});
		expect(answer.transactions).toEqual([
			{connectionId: 'bank-1', ...UBER},
			{connectionId: 'bank-1', ...PAYROLL},
		]);
		expect(answer.accounts).toEqual([{connectionId: 'bank-1', ...CHECKING}]);
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
		expect(transactionsBetween).not.toHaveBeenCalled();
	});
});
