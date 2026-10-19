import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {getAccounts, getTransactions, type PlaidAccount, type PlaidTransaction} from '../connections/plaid/plaid-api';
import {callPlaid, type PlaidClient} from '../connections/plaid/plaid-client';
import type {Connector, DataRecord, ListQuery, RecordPage, RecordTarget} from './connector';
import {readPageToken, writePageToken} from './page-token';

/**
 * A bank login through Plaid, fetched live and only ever read: `accounts`, each account with its
 * balances as of Plaid's last update, and `transactions`, a tree of the accounts each holding its
 * transactions, newest first, 50 to a page. A list inside an account, or a search at the top, which
 * is in every account, is narrowed by days, since Plaid has no search in words.
 *
 * An account's record id is Plaid's account id. Plaid finds a transaction only among those of an
 * account on a day, so a transaction's id is its account's, its day and its own,
 * `lvo4…:2026-10-11:k9oa…`. A pending transaction is replaced by its posted one, with an id of its
 * own, once the bank posts it, and is then not found. Amounts are written as a statement reads:
 * money out of the account negative, money in positive.
 */

const PAGE_SIZE = 50;

// Plaid's ids are letters and digits, 37 of them so far; Plaid refuses an account id of another
// shape as a request it can't read, rather than as one it doesn't have.
const PLAID_ID = /^[A-Za-z0-9]{16,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TRANSACTION_ID = /^([A-Za-z0-9]{16,100}):(\d{4}-\d{2}-\d{2}):([A-Za-z0-9]{16,100})$/;

// Plaid has at most two years before the bank was connected; a list starts from long before that.
const EARLIEST = '2000-01-01';

type TransactionRef = {accountId: string; date: string; transactionId: string};

function parseTransactionRef(recordId: string): TransactionRef | null {
	const [, accountId, date, transactionId] = TRANSACTION_ID.exec(recordId) ?? [];
	if (!accountId || !date || !transactionId || !realDay(date)) {
		return null;
	}
	return {accountId, date, transactionId};
}

// A day the calendar has: not 2026-02-30, which Date rolls into March, nor 2026-13-01, which it can't read.
function realDay(day: string): boolean {
	const date = new Date(`${day}T00:00:00Z`);
	return DAY.test(day) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day);
}

// A list opened inside a record is in an account: transactions hold nothing.
function requireAccountId(recordId: string): Result<string, ApiError> {
	if (parseTransactionRef(recordId)) {
		return Err(ApiErr.validationError('Transactions hold nothing: give an account’s id as parent'));
	}
	if (!PLAID_ID.test(recordId)) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(recordId);
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

// The digits after the point a currency with an ISO code is written with: 2 for USD, 0 for JPY.
function currencyDigits(code: string): number {
	return Result.wrap(() => new Intl.NumberFormat('en-US', {style: 'currency', currency: code}).resolvedOptions().maximumFractionDigits ?? 2).unwrapOr(2);
}

// Plaid writes the currency's code, or for one without an ISO code, such as a cryptocurrency, its
// own; an amount in one of those keeps every digit Plaid gives, 0.00342 BTC.
function money(amount: number | null | undefined, currency: {iso_currency_code?: string | null; unofficial_currency_code?: string | null}): string {
	if (amount === null || amount === undefined) {
		return '';
	}
	if (currency.iso_currency_code) {
		return `${amount.toFixed(currencyDigits(currency.iso_currency_code))} ${currency.iso_currency_code}`;
	}
	const digits = amount.toLocaleString('en-US', {useGrouping: false, maximumFractionDigits: 20});
	return `${digits} ${currency.unofficial_currency_code ?? ''}`.trim();
}

const ACRONYMS: Partial<Record<string, string>> = {cd: 'CD', ira: 'IRA', hsa: 'HSA', '401k': '401(k)', '403b': '403(b)', '529': '529 plan'};

function sentenceCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An account's kind as a person reads it: "Checking", "Credit card", "IRA". */
export function accountType(account: PlaidAccount): string {
	const kind = account.subtype ?? account.type;
	return ACRONYMS[kind] ?? sentenceCase(kind);
}

/** The account number's last digits as the bank shows them, "••0000", or nothing. */
export function accountNumber(account: PlaidAccount): string {
	return account.mask ? `••${account.mask}` : '';
}

function accountLabel(account: PlaidAccount): string {
	return [account.name, accountNumber(account)].filter(Boolean).join(' ');
}

const NEVER = new Date(0).toISOString();

function balanceRecord(account: PlaidAccount): DataRecord {
	const {balances} = account;
	return {
		id: account.account_id,
		values: {
			name: account.name,
			type: accountType(account),
			number: accountNumber(account),
			balance: money(balances.current, balances),
			available: money(balances.available, balances),
			limit: money(balances.limit, balances),
		},
		updatedAt: NEVER,
	};
}

function accountRecord(account: PlaidAccount): DataRecord {
	return {id: account.account_id, values: {name: account.name, kind: 'Account', account: accountLabel(account)}, updatedAt: NEVER, hasChildren: true};
}

// FOOD_AND_DRINK as "Food and drink".
function words(code: string): string {
	return sentenceCase(code.toLowerCase().replaceAll('_', ' '));
}

// Plaid's category, its detailed one without the primary one it starts with: "Food and drink: Restaurant".
function categoryOf(transaction: PlaidTransaction): string {
	const category = transaction.personal_finance_category;
	if (!category) {
		return '';
	}
	const detail = category.detailed.startsWith(`${category.primary}_`) ? category.detailed.slice(category.primary.length + 1) : category.detailed;
	if (detail === '' || detail === category.primary || detail === 'OTHER') {
		return words(category.primary);
	}
	return `${words(category.primary)}: ${words(detail)}`;
}

function locationOf(transaction: PlaidTransaction): string {
	const location = transaction.location;
	return [location?.city, location?.region, location?.country].filter(Boolean).join(', ');
}

function transactionRecord(transaction: PlaidTransaction, accounts: PlaidAccount[]): DataRecord {
	const account = accounts.find((one) => one.account_id === transaction.account_id);
	return {
		id: `${transaction.account_id}:${transaction.date}:${transaction.transaction_id}`,
		values: {
			name: transaction.merchant_name ?? transaction.name,
			kind: 'Transaction',
			date: transaction.date,
			// Plaid's amount is what left the account; a statement shows it taken off.
			amount: money(transaction.amount === 0 ? 0 : -transaction.amount, transaction),
			account: account ? accountLabel(account) : '',
			category: categoryOf(transaction),
			status: transaction.pending ? 'Pending' : 'Posted',
			description: transaction.name,
			location: locationOf(transaction),
		},
		updatedAt: `${transaction.date}T00:00:00.000Z`,
	};
}

// The days a list covers: from a search, else everything up to tomorrow, so a transaction dated
// today in a time zone ahead of the server's is in it.
const SEARCH = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{4}-\d{2}-\d{2}))?$/;

const SEARCH_HELP = 'Search with a day, such as 2026-09-30, for the transactions on it and before it, or two, 2026-09-01 2026-09-30, for those between them';

function tomorrow(): string {
	return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function readSearch(search: string | null): Result<{from: string; to: string}, ApiError> {
	if (search === null) {
		return Ok({from: EARLIEST, to: tomorrow()});
	}
	const [, first = '', second] = SEARCH.exec(search.trim()) ?? [];
	if (!realDay(first) || (second !== undefined && !realDay(second))) {
		return Err(ApiErr.validationError(SEARCH_HELP));
	}
	if (second === undefined) {
		return Ok({from: EARLIEST, to: first});
	}
	return Ok(first <= second ? {from: first, to: second} : {from: second, to: first});
}

// What a list's next page carries: the days it covers, since tomorrow moves, and how far in it is.
const pageSchema = z.object({from: z.string().regex(DAY), to: z.string().regex(DAY), offset: z.number().int().min(0)});

function transactionsPage(client: PlaidClient, accessToken: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const accountId = query.parent === null ? null : $(requireAccountId(query.parent));
		const page = query.page === null ? {...$(readSearch(query.search)), offset: 0} : $(readPageToken(pageSchema, query.page));
		const answer = $((await getTransactions(client, accessToken, {...page, accountId, count: PAGE_SIZE, offset: page.offset})).mapErr(notFoundAs(query.parent ?? '')));
		const records = answer.transactions.map((transaction) => transactionRecord(transaction, answer.accounts));
		const next = page.offset + answer.transactions.length;
		const nextPage = answer.transactions.length > 0 && next < answer.total ? writePageToken({...page, offset: next}) : null;
		const account = answer.accounts.find((one) => one.account_id === accountId);
		const trail = account ? {trail: [{id: account.account_id, title: account.name}]} : {};
		return {records, nextPage, ...trail};
	});
}

/** The accounts, or a page of transactions: one account's, or every account's for a search at the top. */
function listTransactionsTree(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callPlaid(target.connection, (client, accessToken) =>
		Do(async ($) => {
			if (query.parent === null && query.search === null && query.page === null) {
				const {accounts} = $(await getAccounts(client, accessToken));
				return {records: accounts.map(accountRecord), nextPage: null};
			}
			return $(await transactionsPage(client, accessToken, query));
		}),
	);
}

function requireAccount(accounts: PlaidAccount[], recordId: string): Result<PlaidAccount, ApiError> {
	const account = accounts.find((one) => one.account_id === recordId);
	if (!account) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(account);
}

function getTransactionsRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callPlaid(target.connection, (client, accessToken) =>
		Do(async ($) => {
			const ref = parseTransactionRef(recordId);
			if (!ref) {
				const {accounts} = $(await getAccounts(client, accessToken));
				return accountRecord($(requireAccount(accounts, recordId)));
			}
			const query = {from: ref.date, to: ref.date, accountId: ref.accountId, count: 500, offset: 0};
			const answer = $((await getTransactions(client, accessToken, query)).mapErr(notFoundAs(recordId)));
			const transaction = answer.transactions.find((one) => one.transaction_id === ref.transactionId);
			if (!transaction) {
				return $(Err(ApiErr.notFound('record', recordId)));
			}
			return transactionRecord(transaction, answer.accounts);
		}),
	);
}

function listBalances(target: RecordTarget): Promise<Result<RecordPage, ApiError>> {
	return callPlaid(target.connection, (client, accessToken) =>
		Do(async ($) => {
			const {accounts} = $(await getAccounts(client, accessToken));
			return {records: accounts.map(balanceRecord), nextPage: null};
		}),
	);
}

function getBalance(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callPlaid(target.connection, (client, accessToken) =>
		Do(async ($) => {
			const {accounts} = $(await getAccounts(client, accessToken));
			return balanceRecord($(requireAccount(accounts, recordId)));
		}),
	);
}

function readOnly<T>(): Promise<Result<T, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Bank accounts are only read here')));
}

export const plaidConnector: Connector = {
	list: (target, query) => (target.collection.id === 'accounts' ? listBalances(target) : listTransactionsTree(target, query)),
	get: (target, recordId) => (target.collection.id === 'accounts' ? getBalance(target, recordId) : getTransactionsRecord(target, recordId)),
	create: () => readOnly(),
	update: () => readOnly(),
	remove: () => readOnly(),
};
