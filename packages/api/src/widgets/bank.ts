import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {daysBetween} from '@proxy/utils/days';
import type {BankAccount, BankAccounts, BankTransaction, BankTransactions} from '@proxy/contracts/widgets';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {eachSource} from './each-source';
import {findSources, summarize, withCapability} from './sources';

/**
 * Every bank connected, for the Balances and Transactions widgets: each account with its balances,
 * and the transactions of every account between two days, which the web app filters by merchant,
 * kind, account and direction as the person types, so a stretch of days is read from the bank once.
 * Amounts are numbers here, as a statement signs them: money out of an account negative, money in
 * positive, and what a card or a loan owes positive, marked as owed. Each bank is read by its
 * `accounts` and `transactions` connectors.
 */

// Plaid has at most two years before the bank was connected.
const MAX_DAYS = 731;

/** `GET /api/widgets/accounts`: every bank's accounts with their balances. */
export function handleBankAccountsRoute(request: AuthenticatedRequest): Promise<Result<BankAccounts, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'accounts', 'list')), 'balances');
		const {found, failed} = await eachSource(sources, (source) => source.connector.balances(source));
		const accounts = found.flatMap(({source, value}) => value.map((account): BankAccount => ({connectionId: source.connection.id, ...account})));
		return {sources: sources.map(summarize), accounts, failed};
	});
}

// A day the calendar has, as `2026-10-11`: not 2026-02-30, which Date rolls into March.
const day = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'Not a day');

const rangeSchema = z.object({from: day, to: day});

/** `GET /api/widgets/transactions?from=2026-09-01&to=2026-09-30`: every bank's transactions between two days, both included, newest first. */
export function handleBankTransactionsRoute(request: AuthenticatedRequest): Promise<Result<BankTransactions, ApiError>> {
	return Do(async ($) => {
		const range = $(parseSchema(rangeSchema, request.query));
		const days = daysBetween(range.from, range.to);
		if (days < 0 || days >= MAX_DAYS) {
			return $(Err(ApiErr.validationError('Ask for at most two years, from before to')));
		}
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'transactions', 'list')), 'transactionsBetween');
		const {found, failed} = await eachSource(sources, (source) => source.connector.transactionsBetween(source, range));
		const transactions = found
			.flatMap(({source, value}) => value.transactions.map((transaction): BankTransaction => ({connectionId: source.connection.id, ...transaction})))
			.sort((a, b) => b.date.localeCompare(a.date));
		return {
			sources: sources.map(summarize),
			accounts: found.flatMap(({source, value}) => value.accounts.map((account): BankAccount => ({connectionId: source.connection.id, ...account}))),
			transactions,
			more: found.some(({value}) => value.more),
			failed,
		};
	});
}
