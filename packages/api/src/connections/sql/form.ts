import {parseSchema} from '@proxy/utils';
import {databaseBodySchema} from '@proxy/contracts/connections';

import type {ConnectForm} from '../form-connect';
import type {SqlCredential, SqlDialect} from './credential';
import {checkDatabase} from './sql-client';

// What agents get with a new database connection until its page says otherwise: what only reads.
const DEFAULTS = ['read', 'query'];

function accountOf(credential: SqlCredential): string {
	return `${credential.username}@${credential.host}/${credential.database}`;
}

/**
 * The form connecting a database of one dialect, called `name` in the routes' names: signed in to
 * first, so a wrong password, a server out of reach or a private address is reported now rather
 * than on an agent's first request.
 */
export function sqlForm(dialect: SqlDialect, name: string): ConnectForm<SqlCredential> {
	return {
		name,
		read: (request) => parseSchema(databaseBodySchema, request.body).map((credential) => ({account: accountOf(credential), credential})),
		check: (credential) => checkDatabase(dialect, credential),
		defaults: DEFAULTS,
		conflict: 'This database is already connected as this user',
	};
}
