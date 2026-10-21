import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import type {Viewer} from '@proxy/db/connection';

import {log} from '../../observability/log';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireViewer} from '../../utils/user-org';
import {saveConnection} from '../connect-flow';
import {respond, type ConnectionResponse} from '../connection-response';
import {requireManaged} from '../managed';
import {shareBodySchema} from '../ownership';
import {createLinkToken, exchangePublicToken, getAccounts, removeItem} from './plaid-api';
import {readPlaidCredential, requirePlaidClient, type PlaidClient, type PlaidCredential} from './plaid-client';

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

// The access token of a Plaid connection the person may change, for Link's update mode.
function requirePlaidConnection(viewer: Viewer, connectionId: string): Promise<Result<PlaidCredential, ApiError>> {
	return Do(async ($) => {
		const row = $(await requireManaged(viewer, connectionId));
		if (row.integrationId !== 'plaid') {
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
		const {connectionId} = $(parseSchema(linkTokenBodySchema, request.body ?? {}));
		const client = $(requirePlaidClient());
		const viewer = $(await requireViewer(request));
		const accessToken = connectionId === undefined ? null : $(await requirePlaidConnection(viewer, connectionId)).accessToken;
		return {linkToken: $(await createLinkToken(client, {userId: request.user.userId, accessToken}))};
	});
}

async function removeUnsavedItem(client: PlaidClient, credential: PlaidCredential): Promise<void> {
	const removed = await removeItem(client, credential.accessToken);
	if (removed.isErr()) {
		log.warn('Removing a bank login that wasn’t saved failed', {itemId: credential.itemId, kind: removed.error.kind});
	}
}

const connectBodySchema = z.object({publicToken: z.string().min(1)}).extend(shareBodySchema.shape);

/**
 * `POST /api/connections/plaid` with `{publicToken, shared?}` — the public token Link answered
 * with, exchanged and saved as a connection named by its bank, the person's own or every member's.
 */
export function handleConnectPlaidRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const client = $(requirePlaidClient());
		const {publicToken, shared} = $(parseSchema(connectBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		const credential = $(await exchangePublicToken(client, publicToken));
		// The login is made at Plaid by now, and billed: it is saved even when its bank's name can't be read.
		const institution = (await getAccounts(client, credential.accessToken)).map((answer) => answer.institution).unwrapOr(null);
		const saved = await saveConnection(viewer, 'plaid', {account: institution ?? 'Bank', accountId: credential.itemId, credential, defaults: []}, {shared});
		if (saved.isErr()) {
			// A login no connection keeps couldn't be disconnected, and would be billed on: it is removed.
			await removeUnsavedItem(client, credential);
			return $(saved);
		}
		const {row} = saved.value;
		return $(await respond({...row, credential: JSON.stringify(credential)}));
	});
}
