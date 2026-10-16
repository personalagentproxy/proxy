import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest, requirePresent} from '@proxy/utils';

import {env} from '../../utils/env';
import {readStoredJson} from '../../utils/stored-json';

/**
 * Plaid's API with the server's own keys: every call a POST of JSON, the client's id and secret in
 * headers, and Plaid's errors turned into what they mean for the agent and the person. A bank that
 * needs its login again says so, naming the button on the connection's page that does it.
 */

const TIMEOUT_MS = 30_000;

export type PlaidClient = {clientId: string; secret: string; baseUrl: string};

/** The server's Plaid keys, when they are set, for the environment `PLAID_ENV` names. */
export function plaidClient(): PlaidClient | null {
	if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
		return null;
	}
	return {clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, baseUrl: `https://${env.PLAID_ENV}.plaid.com`};
}

export function requirePlaidClient(): Result<PlaidClient, ApiError> {
	const client = plaidClient();
	if (!client) {
		return Err(ApiErr.validationError('Plaid isn’t set up on this server: PLAID_CLIENT_ID and PLAID_SECRET are missing'));
	}
	return Ok(client);
}

/** What a Plaid connection stores, encrypted: the access token Plaid gave for the bank login, and the login's id. */
export const plaidCredentialSchema = z.object({accessToken: z.string(), itemId: z.string()});

export type PlaidCredential = z.infer<typeof plaidCredentialSchema>;

export function readPlaidCredential(stored: string | null): Result<PlaidCredential, ApiError> {
	return Do<PlaidCredential, ApiError>(($) => {
		const present = $(requirePresent(stored, ApiErr.credentialsRejected()));
		return $(readStoredJson(present, plaidCredentialSchema));
	});
}

const plaidErrorSchema = z.object({
	error_type: z.string(),
	error_code: z.string(),
	error_message: z.string().optional(),
	display_message: z.string().nullable().optional(),
});

/** What the agent is told of a bank that needs its login again, and the person on the connection's page. */
export const SIGN_IN_AGAIN =
	'The bank needs its login again before Personal Agent Proxy can read it. The person who connected it signs in again on the connection’s page, with Sign in to the bank again.';

// The bank login no longer works until the person signs in again through Plaid Link's update mode:
// a changed password or a new one-time code, consent withdrawn or run out, or the accounts gone.
const LOGIN_REQUIRED = ['ITEM_LOGIN_REQUIRED', 'ITEM_LOCKED', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS', 'USER_SETUP_REQUIRED', 'INSUFFICIENT_CREDENTIALS'];

/** What one of Plaid's errors means: a login to renew, a record not there, a refusal to pass on, or Plaid or the bank out of reach. */
export function plaidError(error: FetchError): ApiError {
	if (error.kind !== 'http') {
		return ApiErr.providerUnreachable(error);
	}
	const parsed = plaidErrorSchema.safeParse(error.body);
	if (!parsed.success) {
		return ApiErr.providerUnreachable(error);
	}

	const {error_type: type, error_code: code, error_message: message = ''} = parsed.data;
	if (LOGIN_REQUIRED.includes(code)) {
		return ApiErr.validationError(SIGN_IN_AGAIN);
	}
	// Right after a bank is connected, Plaid takes a moment to fetch its transactions.
	if (code === 'PRODUCT_NOT_READY') {
		return ApiErr.validationError('Plaid is still fetching this bank’s transactions. Try again in a minute.');
	}
	// The bank login is gone at Plaid, as after it was removed there.
	if (code === 'INVALID_ACCESS_TOKEN' || code === 'ITEM_NOT_FOUND') {
		return ApiErr.credentialsRejected();
	}
	if (code === 'INVALID_ACCOUNT_ID') {
		return ApiErr.notFound('record');
	}
	if (code === 'INVALID_API_KEYS') {
		return ApiErr.validationError('Plaid turned down this server’s PLAID_CLIENT_ID and PLAID_SECRET for its PLAID_ENV');
	}
	if (type === 'API_ERROR' || type === 'INSTITUTION_ERROR' || type === 'RATE_LIMIT_EXCEEDED' || error.status >= 500) {
		return ApiErr.providerUnreachable(error);
	}
	return ApiErr.validationError(`Plaid: ${message || code}`);
}

/** A call to Plaid's API, `body` sent beside the keys, its answer read with `schema`. */
export async function plaidRequest<S extends z.ZodType>(client: PlaidClient, path: string, body: object, schema: S): Promise<Result<z.infer<S>, ApiError>> {
	const init = {
		method: 'POST',
		headers: {'content-type': 'application/json', 'plaid-client-id': client.clientId, 'plaid-secret': client.secret},
		body: JSON.stringify(body),
	};
	const answer = await httpRequest(`${client.baseUrl}${path}`, init, {schema, timeoutMs: TIMEOUT_MS});
	return answer.mapErr(plaidError);
}

/** Calls Plaid for a connection: the server's keys and the connection's access token. */
export function callPlaid<T>(connection: {credential: string | null}, call: (client: PlaidClient, accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const client = $(requirePlaidClient());
		const credential = $(readPlaidCredential(connection.credential));
		return $(await call(client, credential.accessToken));
	});
}
