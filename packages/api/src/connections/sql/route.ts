import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createConnection, listConnections} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {TLS_MODES, type SqlCredential, type SqlDialect} from './credential';
import {checkDatabase} from './sql-client';

// A host is a name or an address, in brackets when IPv6: no spaces, no path.
const hostSchema = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^[a-zA-Z0-9.\-:[\]]+$/, 'Not a host')
	.transform((host) => host.replace(/^\[(.*)\]$/, '$1'));

// A database connection as typed in: the server, the database and the user. The password may be
// empty, as a local database's can be.
const connectBodySchema = z.object({
	host: hostSchema,
	port: z.number().int().min(1).max(65535),
	database: z.string().trim().min(1).max(200),
	username: z.string().trim().min(1).max(200),
	password: z.string().max(1000),
	tls: z.enum(TLS_MODES),
});

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
	handleConnect: (request: AuthenticatedRequest) => Promise<Result<ConnectionResponse, ApiError>>;
} {
	return {
		handleTest: (request) =>
			Do(async ($) => {
				const credential = $(parseSchema(connectBodySchema, request.body));
				$(await checkDatabase(dialect, credential));
			}),
		handleConnect: (request) =>
			Do(async ($) => {
				const credential = $(parseSchema(connectBodySchema, request.body));
				const account = accountOf(credential);

				const orgId = $(await requireUserOrgId(request));
				const existing = $(await listConnections(orgId));
				if (existing.some((connection) => connection.integrationId === dialect && connection.account === account)) {
					return $(Err(ApiErr.conflict('This database is already connected as this user')));
				}

				const encrypted = $(encryptSecret(JSON.stringify(credential)));
				$(await checkDatabase(dialect, credential));

				const row = $(await createConnection({orgId, integrationId: dialect, account, credential: encrypted, defaults: DEFAULTS}));
				return toConnectionResponse(row);
			}),
	};
}
