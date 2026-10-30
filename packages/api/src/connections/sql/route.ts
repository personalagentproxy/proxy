import {Err, type Result} from 'ts-results-es';
import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createConnection, listConnections} from '@proxy/db/connection';
import {type Connection, databaseBodySchema, shareBodySchema} from '@proxy/contracts/connections';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptSecret} from '../../utils/secret-crypto';
import {requireViewer} from '../../utils/user-org';
import {respond} from '../connection-response';
import {ownership} from '../ownership';
import type {SqlCredential, SqlDialect} from './credential';
import {checkDatabase} from './sql-client';

// What agents get with a new database connection until its page says otherwise: what only reads.
const DEFAULTS = ['read', 'query'];

function accountOf(credential: SqlCredential): string {
	return `${credential.username}@${credential.host}/${credential.database}`;
}

/**
 * The routes connecting a database of one dialect: testing a sign-in, which saves nothing, and
 * connecting, which signs in first, so a wrong password, a server out of reach or a private
 * address is reported now rather than on an agent's first request.
 */
export function sqlConnectRoutes(dialect: SqlDialect): {
	handleTest: (request: AuthenticatedRequest) => Promise<Result<void, ApiError>>;
	handleConnect: (request: AuthenticatedRequest) => Promise<Result<Connection, ApiError>>;
} {
	return {
		handleTest: (request) =>
			Do(async ($) => {
				const credential = $(parseSchema(databaseBodySchema, request.body));
				$(await checkDatabase(dialect, credential));
			}),
		handleConnect: (request) =>
			Do(async ($) => {
				const credential = $(parseSchema(databaseBodySchema, request.body));
				const {shared = false} = $(parseSchema(shareBodySchema, request.body));
				const account = accountOf(credential);

				const viewer = $(await requireViewer(request));
				const existing = $(await listConnections(viewer));
				if (existing.some((connection) => connection.integrationId === dialect && connection.account === account)) {
					return $(Err(ApiErr.conflict('This database is already connected as this user')));
				}

				const encrypted = $(encryptSecret(JSON.stringify(credential)));
				$(await checkDatabase(dialect, credential));

				const row = $(await createConnection({...ownership(viewer, shared), integrationId: dialect, account, credential: encrypted, defaults: DEFAULTS}));
				return $(await respond({...row, credential: encrypted}));
			}),
	};
}
