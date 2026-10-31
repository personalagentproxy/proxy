import {z} from 'zod';

/**
 * Every environment variable the api reads. Kept apart from `env.ts`, which parses
 * `process.env` on import, so the docs can build their reference table from it: each variable's
 * `group` and `description` are written for someone hosting Personal Agent Proxy.
 */

export type EnvDoc = {
	group: 'Core' | 'Sign-in' | 'Connections' | 'Deployment';
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
			'Where people open Personal Agent Proxy, such as `https://proxy.example.com`. Sign-in links and Google sign-in return here, and it is the only origin the api accepts browser requests from. When it is an `https` address on the public internet, MCP servers whose sign-in takes a client ID metadata document fetch Personal Agent Proxy’s from `<APP_URL>/oauth/client-metadata.json`.',
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
				'Encrypts the app passwords, OAuth tokens and vault entries Personal Agent Proxy stores: 32 random bytes, base64 (`openssl rand -base64 32`). Back it up: changing or losing it makes everything stored with it unreadable.',
		},
	),

	ALLOWED_SIGNUP_EMAILS: documented(listSchema.optional(), {
		group: 'Sign-in',
		description:
			'Who can create an account: comma-separated addresses and domains, such as `me@example.com,example.org` (`@example.org` works too). People who already have an account can always sign in. Unset, anyone who can reach Personal Agent Proxy can sign up.',
	}),
	GOOGLE_CLIENT_ID: documented(z.string().min(1).optional(), {
		group: 'Sign-in',
		description:
			'Turns on Google sign-in, with `GOOGLE_CLIENT_SECRET`, and connecting a Google account (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts and Tasks). Register `<APP_URL>/auth/google/callback` and `<APP_URL>/api/connections/google/callback` as redirect URIs, enable the Gmail, Calendar, Drive, Sheets, People and Tasks APIs in the client’s Cloud project, and set the app’s publishing status to In production: in Testing, Google ends a connection’s sign-in after 7 days.',
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

	PLAID_CLIENT_ID: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description:
			'Turns on connecting bank accounts through Plaid, with `PLAID_SECRET`: the client id from the Keys page of your Plaid dashboard. Plaid’s free Trial plan, for new teams in the US and Canada, connects up to 10 banks; past that, Plaid bills each connected bank monthly.',
	}),
	PLAID_SECRET: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description: 'The Plaid secret for the environment `PLAID_ENV` names: Sandbox and Production each have their own.',
	}),
	PLAID_ENV: documented(z.enum(['sandbox', 'production']).default('production'), {
		group: 'Connections',
		description: 'Which of Plaid’s environments to use: `sandbox` connects only Plaid’s test banks, signed in to with `user_good` and `pass_good`.',
	}),

	TYPESAFE_API_KEY: documented(z.string().min(1).optional(), {
		group: 'Core',
		description:
			'A TypeSafe AI API key, for Jev, which picks the widget on the home page that fits what a person types. What is typed there is sent to it. Without it, or without `OPENROUTER_KEY`, the home page says it is not set up; everything else works as before.',
	}),
	OPENROUTER_KEY: documented(z.string().min(1).optional(), {
		group: 'Core',
		description:
			'An OpenRouter API key, for the model that fills in the fields of the widget Jev picks on the home page (gpt-oss-120b, on Cerebras or Groq), and for the built-in agent on the Chat page (Claude Sonnet 5.5). What is typed there is sent to it. Without it, or without `TYPESAFE_API_KEY`, the home page says it is not set up, and without it the Chat page does; everything else works as before.',
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
	ALLOW_PRIVATE_HOSTS: documented(
		z
			.enum(['true', 'false', '1', '0'])
			.transform((value) => value === 'true' || value === '1')
			.default(false),
		{
			group: 'Deployment',
			description:
				"Lets database and custom MCP server connections reach private and local addresses, such as `192.168.1.5`, `10.0.0.7` or `localhost`. They are refused otherwise, so a connection can't be pointed at something else on the server's own network. Set it to `true` when self-hosting beside your database or server.",
		},
	),
});
