import type {Viewer} from '@proxy/db/connection';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {daysBetween} from '@proxy/utils/days';
import type {IntegrationId} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {getAccounts, getTransactions, type PlaidAccount, type PlaidTransaction} from '../connections/plaid/plaid-api';
import {callPlaid} from '../connections/plaid/plaid-client';
import {accountNumber, accountType} from '../records/plaid-connector';
import {eachSource, type Failure} from './each-source';
import {findSources, summarize, type Source, type SourceSummary} from './sources';

/**
 * Every bank connected, for the Balances and Transactions widgets: each account with its balances,
 * and the transactions of every account between two days, which the web app filters by merchant,
 * kind, account and direction as the person types, so a stretch of days is read from the bank once.
 * Amounts are numbers here, as a statement signs them: money out of an account negative, money in
 * positive, and what a card or a loan owes positive, marked as owed.
 */

/** An account as the widgets show it: whose, what kind, and what it holds or owes. */
export type BankAccount = {
	connectionId: string;
	id: string;
	name: string;
	/** "Checking", "Credit card", "Mortgage". */
	type: string;
	/** The account number's last digits, "0000", or nothing. */
	mask: string;
	/** A card or a loan: its balance is what is owed. */
	owed: boolean;
	balance: number | null;
	available: number | null;
	limit: number | null;
	/** The ISO code, or a bank's own for a currency without one. */
	currency: string;
};

export type BankTransaction = {
	connectionId: string;
	accountId: string;
	id: string;
	/** The day, `2026-10-11`. */
	date: string;
	/** The bank's own description. */
	name: string;
	/** The merchant, where the integration knows it. */
	merchant: string | null;
	amount: number;
	currency: string;
	/** One of `TRANSACTION_CATEGORIES`' ids, or none. */
	category: string | null;
	pending: boolean;
};

type Transactions = {accounts: BankAccount[]; transactions: BankTransaction[]; more: boolean};

/** How an integration's banks are read; a bank integration joins the widgets with one. */
type BankAdapter = {
	accounts: (source: Source) => Promise<Result<BankAccount[], ApiError>>;
	/** The transactions between two days, both included, newest first, and whether there were more than were read. */
	transactions: (source: Source, range: DayRange) => Promise<Result<Transactions, ApiError>>;
};

export type DayRange = {from: string; to: string};

// Plaid answers at most 500 transactions a call; a range is read in a few calls, then given up on.
const PAGE = 500;
const PAGES = 3;

// Plaid has at most two years before the bank was connected.
const MAX_DAYS = 731;

function currencyOf(money: {iso_currency_code?: string | null; unofficial_currency_code?: string | null}): string {
	return money.iso_currency_code ?? money.unofficial_currency_code ?? '';
}

function bankAccount(connectionId: string, account: PlaidAccount): BankAccount {
	const {balances} = account;
	return {
		connectionId,
		id: account.account_id,
		name: account.name,
		type: accountType(account),
		mask: accountNumber(account).replace(/^••/, ''),
		owed: account.type === 'credit' || account.type === 'loan',
		balance: balances.current ?? null,
		available: balances.available ?? null,
		limit: balances.limit ?? null,
		currency: currencyOf(balances),
	};
}

function bankTransaction(connectionId: string, transaction: PlaidTransaction): BankTransaction {
	return {
		connectionId,
		accountId: transaction.account_id,
		id: transaction.transaction_id,
		date: transaction.date,
		name: transaction.name,
		merchant: transaction.merchant_name ?? null,
		// Plaid's amount is what left the account; a statement shows it taken off.
		amount: transaction.amount === 0 ? 0 : -transaction.amount,
		currency: currencyOf(transaction),
		category: transaction.personal_finance_category?.primary ?? null,
		pending: transaction.pending,
	};
}

const plaidBank: BankAdapter = {
	accounts: (source) =>
		callPlaid(source.connection, (client, accessToken) =>
			Do(async ($) => {
				const {accounts} = $(await getAccounts(client, accessToken));
				return accounts.map((account) => bankAccount(source.connection.id, account));
			}),
		),
	transactions: (source, range) =>
		callPlaid(source.connection, (client, accessToken) =>
			Do(async ($) => {
				const transactions: BankTransaction[] = [];
				let accounts: PlaidAccount[] = [];
				let total = 0;
				for (let page = 0; page < PAGES; page += 1) {
					const answer = $(await getTransactions(client, accessToken, {...range, accountId: null, count: PAGE, offset: transactions.length}));
					transactions.push(...answer.transactions.map((transaction) => bankTransaction(source.connection.id, transaction)));
					accounts = answer.accounts;
					total = answer.total;
					if (answer.transactions.length === 0 || transactions.length >= total) {
						break;
					}
				}
				return {accounts: accounts.map((account) => bankAccount(source.connection.id, account)), transactions, more: transactions.length < total};
			}),
		),
};

const ADAPTERS: Partial<Record<IntegrationId, BankAdapter>> = {plaid: plaidBank};

// Every bank connected whose collection a widget can read, with how.
async function bankSources(viewer: Viewer, collectionId: 'accounts' | 'transactions'): Promise<Result<Array<Source & {adapter: BankAdapter}>, ApiError>> {
	return (await findSources(viewer, collectionId, 'list')).map((sources) =>
		sources.flatMap((source) => {
			const adapter = ADAPTERS[source.integration.id];
			return adapter ? [{...source, adapter}] : [];
		}),
	);
}

export type BankAccounts = {sources: SourceSummary[]; accounts: BankAccount[]; failed: Failure[]};

/** `GET /api/widgets/accounts`: every bank's accounts with their balances. */
export function handleBankAccountsRoute(request: AuthenticatedRequest): Promise<Result<BankAccounts, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const sources = $(await bankSources(viewer, 'accounts'));
		const {found, failed} = await eachSource(sources, (source) => source.adapter.accounts(source));
		return {sources: sources.map(summarize), accounts: found.flatMap(({value}) => value), failed};
	});
}

// A day the calendar has, as `2026-10-11`: not 2026-02-30, which Date rolls into March.
const day = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'Not a day');

const rangeSchema = z.object({from: day, to: day});

export type BankTransactions = {sources: SourceSummary[]; accounts: BankAccount[]; transactions: BankTransaction[]; more: boolean; failed: Failure[]};

/** `GET /api/widgets/transactions?from=2026-09-01&to=2026-09-30`: every bank's transactions between two days, both included, newest first. */
export function handleBankTransactionsRoute(request: AuthenticatedRequest): Promise<Result<BankTransactions, ApiError>> {
	return Do(async ($) => {
		const range = $(parseSchema(rangeSchema, request.query));
		const days = daysBetween(range.from, range.to);
		if (days < 0 || days >= MAX_DAYS) {
			return $(Err(ApiErr.validationError('Ask for at most two years, from before to')));
		}
		const viewer = $(await requireViewer(request));
		const sources = $(await bankSources(viewer, 'transactions'));
		const {found, failed} = await eachSource(sources, (source) => source.adapter.transactions(source, range));
		const transactions = found.flatMap(({value}) => value.transactions).sort((a, b) => b.date.localeCompare(a.date));
		return {
			sources: sources.map(summarize),
			accounts: found.flatMap(({value}) => value.accounts),
			transactions,
			more: found.some(({value}) => value.more),
			failed,
		};
	});
}
