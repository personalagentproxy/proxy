import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createConnection, listConnections} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import type {TickTickCredential} from './credential';
import {checkToken} from './ticktick-api';

// A TickTick account as typed in: the name it is shown by, since the Open API doesn't say whose a
// token is, and the personal API token from TickTick's settings, without spaces.
const connectBodySchema = z.object({
	account: z.string().trim().min(1).max(200),
	token: z.string().trim().min(1).max(500).regex(/^\S+$/, 'Not an API token'),
});

// What agents get with a new TickTick connection until its page says otherwise: reading.
const DEFAULTS = ['read'];

/** Signs in to TickTick with the token and saves nothing: the Test connection button. */
export function handleTestTickTickRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {token} = $(parseSchema(connectBodySchema, request.body));
		$(await checkToken(token));
	});
}

/**
 * Connects a TickTick account with a personal API token. Signs in first, so a wrong or revoked
 * token is reported now rather than on an agent's first request. The token can't be limited, so
 * agents get only reading until the connection's page says otherwise.
 */
export function handleConnectTickTickRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const {account, token} = $(parseSchema(connectBodySchema, request.body));

		const orgId = $(await requireUserOrgId(request));
		const existing = $(await listConnections(orgId));
		if (existing.some((connection) => connection.integrationId === 'ticktick' && connection.account === account)) {
			return $(Err(ApiErr.conflict('A TickTick account is already connected by this name')));
		}

		const credential: TickTickCredential = {token};
		const encrypted = $(encryptSecret(JSON.stringify(credential)));
		$(await checkToken(token));

		const row = $(await createConnection({orgId, integrationId: 'ticktick', account, credential: encrypted, defaults: DEFAULTS}));
		return toConnectionResponse(row);
	});
}
