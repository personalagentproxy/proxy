import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {getConnectionWithCredential} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireUserOrgId} from '../../utils/user-org';
import {saveConnection} from '../connect-flow';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {createLinkToken, exchangePublicToken, getAccounts} from './plaid-api';
import {readPlaidCredential, requirePlaidClient, type PlaidCredential} from './plaid-client';

/**
 * Connecting a bank through Plaid. Plaid Link runs in the browser, in a window of Plaid's own, so
 * nothing comes back to a callback here: the web app asks for a Link token, Link signs in to the
 * bank (an OAuth bank in a popup) and answers the browser with a public token, which the browser
 * posts back to be exchanged for the access token the connection keeps. Each bank login is a
 * connection of its own, named by its bank, found by Plaid's id for it. Signing in to a bank again
 * is Link's update mode on the same login, which keeps its access token, so nothing is saved after
 * it. A new connection gives agents nothing until a default or an agent's own setting says
 * otherwise.
 */

const linkTokenBodySchema = z.object({connectionId: z.string().min(1).optional()});

// The access token of the organization's Plaid connection, for Link's update mode.
function requirePlaidConnection(orgId: string, connectionId: string): Promise<Result<PlaidCredential, ApiError>> {
	return Do(async ($) => {
		const row = $(await getConnectionWithCredential(orgId, connectionId));
		if (!row || row.integrationId !== 'plaid') {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		return $(readPlaidCredential(row.credential));
	});
}

/**
 * `POST /api/connections/plaid/link-token` — a Link token for the web app's Plaid Link: a new bank,
 * or, with `connectionId`, signing in again to the bank of that connection.
 */
export function handleCreatePlaidLinkTokenRoute(request: AuthenticatedRequest): Promise<Result<{linkToken: string}, ApiError>> {
	return Do(async ($) => {
		const client = $(requirePlaidClient());
		const {connectionId} = $(parseSchema(linkTokenBodySchema, request.body ?? {}));
		const orgId = $(await requireUserOrgId(request));
		const accessToken = connectionId === undefined ? null : $(await requirePlaidConnection(orgId, connectionId)).accessToken;
		return {linkToken: $(await createLinkToken(client, {userId: request.user.userId, accessToken}))};
	});
}

const connectBodySchema = z.object({publicToken: z.string().min(1)});

/** `POST /api/connections/plaid` — the public token Link answered with, exchanged and saved as a connection named by its bank. */
export function handleConnectPlaidRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const client = $(requirePlaidClient());
		const {publicToken} = $(parseSchema(connectBodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const credential = $(await exchangePublicToken(client, publicToken));
		// The login is made at Plaid by now, and billed: it is saved even when its bank's name can't be read.
		const institution = (await getAccounts(client, credential.accessToken)).map((answer) => answer.institution).unwrapOr(null);
		const {row} = $(await saveConnection(orgId, 'plaid', {account: institution ?? 'Bank', accountId: credential.itemId, credential, defaults: []}));
		// Plaid's login covers everything the integration does: every action is available.
		return toConnectionResponse(row, []);
	});
}
