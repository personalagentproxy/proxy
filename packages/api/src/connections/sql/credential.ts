import {z} from 'zod';

/** The databases Personal Agent Proxy speaks to over their own protocol, each an integration. */
export type SqlDialect = 'postgres' | 'mysql';

// How the connection is encrypted: verifying the server's certificate against the host's name,
// encrypted but taking any certificate, as a self-signed one, or in the clear.
export const TLS_MODES = ['verify', 'require', 'off'] as const;

export type TlsMode = (typeof TLS_MODES)[number];

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
