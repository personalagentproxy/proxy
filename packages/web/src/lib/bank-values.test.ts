/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import type {BankAccount, BankTransaction} from '@/client/widgets-client';
import {
	filterTransactions,
	formatMoney,
	matchAccounts,
	rangeAsked,
	rangeBefore,
	totalsOf,
} from '@/lib/bank-values';

// Wednesday 14 October 2026, 14:30 local time.
const now = new Date(2026, 9, 14, 14, 30);

function account(name: string, type: string, mask: string, owed = false): BankAccount {
	return {
		connectionId: 'b',
		id: name,
		name,
		type,
		mask,
		owed,
		balance: 1,
		available: null,
		limit: null,
		currency: 'USD',
	};
}

const checking = account('Plaid Checking', 'Checking', '0000');
const savings = account('Plaid Saving', 'Savings', '1111');
const amex = account('Amex Gold', 'Credit card', '3333', true);
const mortgage = account('Home loan', 'Mortgage', '', true);
const accounts = [checking, savings, amex, mortgage];

function transaction(
	date: string,
	merchant: string | null,
	name: string,
	amount: number,
	category: string | null,
	accountId = 'Plaid Checking',
): BankTransaction {
	return {
		connectionId: 'b',
		accountId,
		id: `${date} ${name}`,
		date,
		name,
		merchant,
		amount,
		currency: 'USD',
		category,
		pending: false,
	};
}

describe('rangeAsked', () => {
	test('reads days said by name, on the calendar', () => {
		const asked = (typed: string) => {
			const {from, to, said} = rangeAsked(typed, now);
			return [from, to, said];
		};
		expect(asked('what did I spend today')).toEqual(['2026-10-14', '2026-10-14', 'today']);
		expect(asked('uber yesterday')).toEqual(['2026-10-13', '2026-10-13', 'yesterday']);
		expect(asked('spending this week')).toEqual(['2026-10-12', '2026-10-14', 'this week']);
		expect(asked('spending last week')).toEqual(['2026-10-05', '2026-10-11', 'last week']);
		expect(asked('restaurants this month')).toEqual(['2026-10-01', '2026-10-14', 'this month']);
		expect(asked('restaurants last month')).toEqual(['2026-09-01', '2026-09-30', 'last month']);
		expect(asked('how much did I spend this year')).toEqual([
			'2026-01-01',
			'2026-10-14',
			'this year',
		]);
		expect(asked('travel last year')).toEqual(['2025-01-01', '2025-12-31', 'last year']);
	});

	test('reads a stretch up to today: the last 90 days, the past two weeks, the past month', () => {
		expect(rangeAsked('spending in the last 90 days', now)).toMatchObject({
			from: '2026-07-17',
			to: '2026-10-14',
			said: 'the last 90 days',
		});
		expect(rangeAsked('uber the past two weeks', now)).toMatchObject({
			from: '2026-10-01',
			to: '2026-10-14',
			said: 'the last 2 weeks',
		});
		expect(rangeAsked('the past month', now)).toMatchObject({
			from: '2026-09-15',
			to: '2026-10-14',
			said: 'the last month',
		});
		expect(rangeAsked('since october 1', now)).toMatchObject({
			from: '2026-10-01',
			to: '2026-10-14',
			said: 'since Oct 1',
		});
	});

	test('reads a month by name as the last one of that name, and a year in digits', () => {
		expect(rangeAsked('restaurants in september', now)).toMatchObject({
			from: '2026-09-01',
			to: '2026-09-30',
			said: 'September',
		});
		expect(rangeAsked('restaurants in october', now)).toMatchObject({
			from: '2026-10-01',
			to: '2026-10-14',
			said: 'October',
		});
		expect(rangeAsked('restaurants in december', now)).toMatchObject({
			from: '2025-12-01',
			to: '2025-12-31',
			said: 'December 2025',
		});
		expect(rangeAsked('what did I spend in 2025', now)).toMatchObject({
			from: '2025-01-01',
			to: '2025-12-31',
			said: '2025',
		});
	});

	test('reads two days, a day, and the last friday; never a time of day alone', () => {
		expect(rangeAsked('from october 1 to october 10', now)).toMatchObject({
			from: '2026-10-01',
			to: '2026-10-10',
			said: 'Oct 1 – Oct 10',
		});
		expect(rangeAsked('charges on october 3', now)).toMatchObject({
			from: '2026-10-03',
			to: '2026-10-03',
			said: 'Oct 3',
		});
		expect(rangeAsked('what did I buy on friday', now)).toMatchObject({
			from: '2026-10-09',
			to: '2026-10-09',
			said: 'Oct 9',
		});
		expect(rangeAsked('the 3pm charge', now)).toMatchObject({defaulted: true});
	});

	test('is the last 30 days when no days are said', () => {
		expect(rangeAsked('uber charges', now)).toEqual({
			from: '2026-09-15',
			to: '2026-10-14',
			said: 'the last 30 days',
			defaulted: true,
		});
	});
});

describe('rangeBefore', () => {
	test('is the same stretch before: whole months as months, else as many days', () => {
		expect(rangeBefore({from: '2026-09-01', to: '2026-09-30'})).toEqual({
			from: '2026-08-01',
			to: '2026-08-31',
			said: 'the month before',
		});
		expect(rangeBefore({from: '2026-01-01', to: '2026-12-31'})).toEqual({
			from: '2025-01-01',
			to: '2025-12-31',
			said: 'the year before',
		});
		expect(rangeBefore({from: '2026-10-01', to: '2026-10-14'})).toEqual({
			from: '2026-09-17',
			to: '2026-09-30',
			said: 'the 14 days before',
		});
		expect(rangeBefore({from: '2026-10-05', to: '2026-10-11'})).toEqual({
			from: '2026-09-28',
			to: '2026-10-04',
			said: 'the week before',
		});
		expect(rangeBefore({from: '2026-10-13', to: '2026-10-13'})).toEqual({
			from: '2026-10-12',
			to: '2026-10-12',
			said: 'the day before',
		});
	});
});

describe('matchAccounts', () => {
	test('finds accounts by name, kind, last digits, or a word for the kind', () => {
		expect(matchAccounts(accounts, 'checking')).toEqual([checking]);
		expect(matchAccounts(accounts, 'my amex')).toEqual([amex]);
		expect(matchAccounts(accounts, 'the card')).toEqual([amex]);
		expect(matchAccounts(accounts, 'credit card')).toEqual([amex]);
		expect(matchAccounts(accounts, 'savings account')).toEqual([savings]);
		expect(matchAccounts(accounts, 'account ending in 3333')).toEqual([amex]);
		expect(matchAccounts(accounts, 'my mortgage')).toEqual([mortgage]);
		expect(matchAccounts(accounts, 'the loan')).toEqual([mortgage]);
	});

	test('finds none for nothing said, filler alone, or a name no account has', () => {
		expect(matchAccounts(accounts, null)).toEqual([]);
		expect(matchAccounts(accounts, 'my account')).toEqual([]);
		expect(matchAccounts(accounts, 'chase')).toEqual([]);
	});
});

describe('filterTransactions and totalsOf', () => {
	const uber = transaction('2026-10-11', 'Uber', 'Uber 063015 SF**POOL**', -5.4, 'TRANSPORTATION');
	const payroll = transaction('2026-10-10', null, 'ACME PAYROLL', 2500, 'INCOME');
	const groceries = transaction(
		'2026-10-03',
		'Whole Foods',
		'WHOLEFDS SF',
		-82.15,
		'FOOD_AND_DRINK',
		'Amex Gold',
	);
	const older = transaction('2026-09-12', 'Uber', 'Uber 091215', -12.8, 'TRANSPORTATION');
	const all = [uber, payroll, groceries, older];
	const october = {from: '2026-10-01', to: '2026-10-14'};
	const any = {range: october, merchant: null, category: null, flow: null, accountIds: null};

	test('keeps the days, the merchant by its name or the bank’s words, the kind, the direction and the accounts', () => {
		expect(filterTransactions(all, any)).toEqual([uber, payroll, groceries]);
		expect(filterTransactions(all, {...any, merchant: 'uber'})).toEqual([uber]);
		expect(filterTransactions(all, {...any, merchant: 'acme'})).toEqual([payroll]);
		expect(filterTransactions(all, {...any, category: 'FOOD_AND_DRINK'})).toEqual([groceries]);
		expect(filterTransactions(all, {...any, flow: 'in'})).toEqual([payroll]);
		expect(filterTransactions(all, {...any, flow: 'out'})).toEqual([uber, groceries]);
		expect(filterTransactions(all, {...any, accountIds: ['Amex Gold']})).toEqual([groceries]);
		expect(
			filterTransactions(all, {...any, range: {from: '2026-09-01', to: '2026-09-30'}}),
		).toEqual([older]);
	});

	test('adds up what went out and what came in, per currency', () => {
		expect(totalsOf([uber, payroll, groceries])).toEqual([
			{currency: 'USD', out: 87.55, in: 2500, count: 3},
		]);
		expect(totalsOf([{...uber, currency: 'EUR'}, payroll, groceries])).toEqual([
			{currency: 'USD', out: 82.15, in: 2500, count: 2},
			{currency: 'EUR', out: 5.4, in: 0, count: 1},
		]);
	});
});

describe('formatMoney', () => {
	test('writes an amount in its currency, and one Intl doesn’t know with its code', () => {
		expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
		expect(formatMoney(15000, 'JPY')).toBe('¥15,000');
		expect(formatMoney(0.00342, 'BTC')).toBe('0.00342 BTC');
	});
});
