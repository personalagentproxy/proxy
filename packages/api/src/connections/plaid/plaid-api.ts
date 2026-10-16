import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';

import {plaidRequest, type PlaidClient} from './plaid-client';

/**
 * The parts of Plaid's API Personal Agent Proxy uses: Link tokens for connecting a bank and signing
 * in to it again, the public token's exchange, a bank login's accounts and transactions, and
 * removing the login, which ends what Plaid bills for it. Only Transactions is asked for: its
 * accounts come with their balances as of Plaid's last update, several times a day, without the
 * per-request fee of Plaid's live Balance.
 */

// As far back as Plaid fetches: two years before the bank was connected.
const DAYS_REQUESTED = 730;

const linkTokenSchema = z.object({link_token: z.string()});

/**
 * A Link token for the web app's Plaid Link: a new bank login, or, with `accessToken`, Link's
 * update mode for one already connected, where the person signs in to the bank again or changes
 * which accounts it shares. `userId` is Personal Agent Proxy's user, as Plaid asks.
 */
export function createLinkToken(client: PlaidClient, args: {userId: string; accessToken: string | null}): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const request = {client_name: 'Personal Agent Proxy', language: 'en', country_codes: ['US', 'CA'], user: {client_user_id: args.userId}};
		const body =
			args.accessToken === null
				? {...request, products: ['transactions'], transactions: {days_requested: DAYS_REQUESTED}}
				: {...request, access_token: args.accessToken, update: {account_selection_enabled: true}};
		return $(await plaidRequest(client, '/link/token/create', body, linkTokenSchema)).link_token;
	});
}

const exchangeSchema = z.object({access_token: z.string(), item_id: z.string()});

/** The access token and login id for the public token Link answered with. */
export function exchangePublicToken(client: PlaidClient, publicToken: string): Promise<Result<{accessToken: string; itemId: string}, ApiError>> {
	return Do(async ($) => {
		const answer = $(await plaidRequest(client, '/item/public_token/exchange', {public_token: publicToken}, exchangeSchema));
		return {accessToken: answer.access_token, itemId: answer.item_id};
	});
}

const accountSchema = z.object({
	account_id: z.string(),
	name: z.string(),
	official_name: z.string().nullable().optional(),
	mask: z.string().nullable().optional(),
	type: z.string(),
	subtype: z.string().nullable().optional(),
	balances: z.object({
		current: z.number().nullable().optional(),
		available: z.number().nullable().optional(),
		limit: z.number().nullable().optional(),
		iso_currency_code: z.string().nullable().optional(),
		unofficial_currency_code: z.string().nullable().optional(),
	}),
});

export type PlaidAccount = z.infer<typeof accountSchema>;

const itemSchema = z.object({item_id: z.string(), institution_id: z.string().nullable().optional(), institution_name: z.string().nullable().optional()});

const accountsSchema = z.object({accounts: z.array(accountSchema), item: itemSchema});

/** The bank login's accounts, with their balances as of Plaid's last update, and the bank's name. */
export function getAccounts(client: PlaidClient, accessToken: string): Promise<Result<{accounts: PlaidAccount[]; institution: string | null}, ApiError>> {
	return Do(async ($) => {
		const answer = $(await plaidRequest(client, '/accounts/get', {access_token: accessToken}, accountsSchema));
		return {accounts: answer.accounts, institution: answer.item.institution_name ?? null};
	});
}

const transactionSchema = z.object({
	transaction_id: z.string(),
	account_id: z.string(),
	// Money leaving the account is positive, as Plaid writes it; money coming in negative.
	amount: z.number(),
	iso_currency_code: z.string().nullable().optional(),
	unofficial_currency_code: z.string().nullable().optional(),
	date: z.string(),
	name: z.string(),
	merchant_name: z.string().nullable().optional(),
	pending: z.boolean(),
	personal_finance_category: z.object({primary: z.string(), detailed: z.string()}).nullable().optional(),
	location: z
		.object({
			city: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
			country: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
	website: z.string().nullable().optional(),
});

export type PlaidTransaction = z.infer<typeof transactionSchema>;

const transactionsSchema = z.object({accounts: z.array(accountSchema), transactions: z.array(transactionSchema), total_transactions: z.number()});

export type TransactionsQuery = {from: string; to: string; accountId: string | null; count: number; offset: number};

/**
 * The transactions between two days, both included, newest first: `count` of them from `offset`
 * on, of one account or of all of them, with how many there are in all and the accounts.
 */
export function getTransactions(
	client: PlaidClient,
	accessToken: string,
	query: TransactionsQuery,
): Promise<Result<{accounts: PlaidAccount[]; transactions: PlaidTransaction[]; total: number}, ApiError>> {
	return Do(async ($) => {
		const options = {count: query.count, offset: query.offset, ...(query.accountId === null ? {} : {account_ids: [query.accountId]})};
		const body = {access_token: accessToken, start_date: query.from, end_date: query.to, options};
		const answer = $(await plaidRequest(client, '/transactions/get', body, transactionsSchema));
		return {accounts: answer.accounts, transactions: answer.transactions, total: answer.total_transactions};
	});
}

/** Removes the bank login at Plaid: its access token stops working, and Plaid stops billing for it. */
export function removeItem(client: PlaidClient, accessToken: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		$(await plaidRequest(client, '/item/remove', {access_token: accessToken}, z.object({})));
	});
}
