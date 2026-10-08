import {z} from 'zod';

/**
 * Every environment variable the api reads. Kept apart from `env.ts`, which parses
 * `process.env` on import, so the docs can build their reference table from it: each variable's
 * `group` and `description` are written for someone hosting Personal Agent Proxy.
 */

export type EnvDoc = {
	group: 'Core' | 'Sign-in' | 'Deployment';
	description: string;
	// Personal Agent Proxy does not work without it, though the api still starts so its errors can say why.
	required?: true;
};

/** Each variable's docs, looked up by its schema. */
export const envDocs = z.registry<EnvDoc>();

function documented<T extends z.ZodType>(schema: T, doc: EnvDoc): T {
	envDocs.add(schema, doc);
	return schema;
}

// Trailing slashes are stripped so callers can build `${url}/path` without producing `//path`.
const originSchema = z.url().transform((value) => value.replace(/\/+$/, ''));

// A comma-separated list, trimmed and lowercased, with empty entries dropped.
const listSchema = z.string().transform((value) =>
	value
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0),
);

export const envSchema = z.object({
	DATABASE_URL: documented(z.url(), {
		group: 'Core',
		required: true,
		description: 'The Postgres connection string. Percent-encode special characters in the password (`@` is `%40`).',
	}),
	APP_URL: documented(originSchema.optional(), {
		group: 'Core',
		required: true,
		description:
			'Where people open Personal Agent Proxy, such as `https://proxy.example.com`. Sign-in links and Google sign-in return here, and it is the only origin the api accepts browser requests from.',
	}),
	AUTH_SECRET: documented(z.string().min(1).optional(), {
		group: 'Core',
		required: true,
		description: 'Hashes magic-link tokens before they are stored. Any long random string: `openssl rand -hex 32`.',
	}),
	ENCRYPTION_KEY: documented(
		z
			.string()
			.refine((value) => Buffer.from(value, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64')
			.optional(),
		{
			group: 'Core',
			required: true,
			description:
				'Encrypts the app passwords and Information records Personal Agent Proxy stores: 32 random bytes, base64 (`openssl rand -base64 32`). Back it up: changing or losing it makes everything stored with it unreadable.',
		},
	),

	ALLOWED_SIGNUP_EMAILS: documented(listSchema.optional(), {
		group: 'Sign-in',
		description:
			'Who can create an account: comma-separated addresses and domains, such as `me@example.com,example.org` (`@example.org` works too). People who already have an account can always sign in. Unset, anyone who can reach Personal Agent Proxy can sign up.',
	}),
	GOOGLE_CLIENT_ID: documented(z.string().min(1).optional(), {
		group: 'Sign-in',
		description: 'Turns on Google sign-in, with `GOOGLE_CLIENT_SECRET`. Register `<APP_URL>/auth/google/callback` as the redirect URI.',
	}),
	GOOGLE_CLIENT_SECRET: documented(z.string().min(1).optional(), {
		group: 'Sign-in',
		description: 'The secret of the Google OAuth client.',
	}),
	RESEND_KEY: documented(z.string().min(1).optional(), {
		group: 'Sign-in',
		description: 'Sends magic-link emails through Resend, with `EMAIL_FROM`. Without it the api writes each link to its log instead, which is enough when you are the only one signing in.',
	}),
	EMAIL_FROM: documented(z.string().min(1).optional(), {
		group: 'Sign-in',
		description: 'The sender of magic-link emails, such as `Personal Agent Proxy <login@example.com>`, on a domain verified with Resend.',
	}),

	NODE_ENV: documented(z.enum(['development', 'test', 'production']).default('production'), {
		group: 'Deployment',
		description: '`development` turns on the dev-only sign-in and logs magic links instead of sending them. Only `bun run dev` sets it.',
	}),
	PORT: documented(z.string().regex(/^\d+$/, 'PORT must be a positive integer').default('4000'), {
		group: 'Deployment',
		description: 'The port the api listens on.',
	}),
	TELEMETRY_ENABLED: documented(
		z
			.enum(['true', 'false', '1', '0'])
			.transform((value) => value === 'true' || value === '1')
			.default(true),
		{
			group: 'Deployment',
			description: 'Sends one anonymous heartbeat a day: a random id, the version and the time. `false` turns it off.',
		},
	),
	APP_VERSION: documented(z.string().default('unknown'), {
		group: 'Deployment',
		description: 'The version telemetry reports. The official image sets it.',
	}),
});
