import {z} from 'zod';

import {TLS_MODES} from '@proxy/contracts/connections';

/** The databases Personal Agent Proxy speaks to over their own protocol, each an integration. */
export type SqlDialect = 'postgres' | 'mysql';

/** What a database connection stores, encrypted: where the database is and the user it signs in as. */
export const sqlCredentialSchema = z.object({
	host: z.string(),
	port: z.number().int(),
	database: z.string(),
	username: z.string(),
	password: z.string(),
	tls: z.enum(TLS_MODES),
});

export type SqlCredential = z.infer<typeof sqlCredentialSchema>;
