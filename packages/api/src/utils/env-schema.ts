import {z} from 'zod';

/**
 * Every environment variable the api reads. Kept apart from `env.ts`, which parses
 * `process.env` on import, so the docs can build their reference table from it: each variable's
 * `group` and `description` are written for someone hosting Personal Agent Proxy.
 */

export type EnvDoc = {
	group: 'Core' | 'Sign-in' | 'Connections' | 'Deployment' | 'Observability';
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

	GITHUB_CLIENT_ID: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description:
			'Turns on connecting GitHub, with `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG`: the client id of a GitHub App of your own, registered under your account’s or organization’s developer settings with `<APP_URL>/api/connections/github/callback` as a callback URL, “Expire user authorization tokens” on and “Request user authorization (OAuth) during installation” off, no webhook, Contents and Pull requests read and write, Metadata read and Email addresses read. People install it on the repositories they choose and sign in to it here.',
	}),
	GITHUB_CLIENT_SECRET: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description: 'A client secret of the GitHub App, generated on its page.',
	}),
	GITHUB_APP_SLUG: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description: 'The GitHub App’s name as it is in its address, `github.com/apps/<slug>`, where people are sent to install it on their account or an organization.',
	}),

	SANDBOX_SERVICE_URL: documented(z.union([z.literal('dev'), originSchema]).optional(), {
		group: 'Connections',
		description:
			'Turns on sandboxes, computers of their own that agents can ask for: the address of a sandbox service speaking the protocol in `@proxy/contracts/sandbox`, such as `https://sandboxes.example.com`, reached with `SANDBOX_SERVICE_TOKEN`; hosted Personal Agent Proxy runs its own. `dev` instead runs commands in a directory on this server with no isolation at all, which only `bun run dev` takes. Unset, agents are offered no sandboxes.',
	}),
	SANDBOX_SERVICE_TOKEN: documented(z.string().min(1).optional(), {
		group: 'Connections',
		description: 'What the sandbox service takes as the bearer token: the same long random string on both sides.',
	}),

	TYPESAFE_API_KEY: documented(z.string().min(1).optional(), {
		group: 'Core',
		description:
			'A TypeSafe AI API key, for Jev, which picks the widget on the home page that fits what a person types. What is typed there is sent to it. Without it, or without `OPENROUTER_KEY`, the home page says it is not set up; everything else works as before.',
	}),
	OPENROUTER_KEY: documented(z.string().min(1).optional(), {
		group: 'Core',
		description:
			'An OpenRouter API key, for the model that fills in the fields of the widget Jev picks on the home page (gpt-oss-120b, on Cerebras or Groq), and for the built-in agent on the Chat page (Claude Sonnet 5.5, or GLM 5.3 where an agent is set to it). What is typed there is sent to it. Without it, or without `TYPESAFE_API_KEY`, the home page says it is not set up, and without it the Chat page does; everything else works as before.',
	}),
	CLAUDE_AGENT_SDK: documented(z.enum(['on', 'off']).default('on'), {
		group: 'Core',
		description:
			'Whether an agent on the Chat page can be set to run on the Claude Agent SDK, under each member’s own Claude account, connected on the Account page: their conversations with it then go to Anthropic directly, as from Claude Code, and count against their plan rather than `OPENROUTER_KEY`. `off` takes the harness away, and an agent that was set to it runs on the server’s OpenRouter key. Each turn on the SDK runs Claude Code as a subprocess of a few hundred megabytes; `CLAUDE_AGENT_SDK_TURNS` caps how many run at once.',
	}),
	CLAUDE_AGENT_SDK_TURNS: documented(z.coerce.number().int().positive().default(1), {
		group: 'Core',
		description:
			'How many turns of the built-in agent on the Claude Agent SDK one api instance runs at once; the rest wait their turn. Each is a subprocess of a few hundred megabytes, so raise it only with the memory to match.',
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
	LOKI_URL: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description:
			'Ships the api’s log to a Loki as well as to stdout: its address, such as `loki-ab12:3100` for one of your own on the same private network, which takes no more and no scheme, or `https://logs-prod-021.grafana.net` for Grafana Cloud’s, with `LOKI_USER_ID` and `GRAFANA_CLOUD_TOKEN`. Unset, the log is written to stdout alone, one JSON object per line.',
	}),
	LOKI_USER_ID: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description: 'The numeric user id of the Grafana Cloud stack’s Loki, from its details page; unset for a Loki of your own.',
	}),
	GRAFANA_CLOUD_TOKEN: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description: 'A Grafana Cloud access policy token that may write logs and metrics.',
	}),
	METRICS_OTLP_URL: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description:
			'Pushes the api’s metrics, such as request and query counts and latencies, over OTLP: to a Prometheus of your own taking OTLP, by its address alone, such as `prometheus-ab12:9090`, which takes no more and no scheme, or to Grafana Cloud’s gateway, such as `https://otlp-gateway-prod-us-west-0.grafana.net/otlp/v1/metrics`, with `METRICS_USER_ID` and `GRAFANA_CLOUD_TOKEN`. Unset, nothing is pushed.',
	}),
	METRICS_USER_ID: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description: 'The numeric instance id of the Grafana Cloud stack’s OTLP gateway, from its details page; unset for a Prometheus of your own.',
	}),
	SLACK_BOT_TOKEN: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description: 'Posts each sign-up to Slack, with `SLACK_CHANNEL_SIGNUPS`: a bot token (`xoxb-…`) of an app with `chat:write`, invited to the channel. Unset, nothing is posted.',
	}),
	SLACK_CHANNEL_SIGNUPS: documented(z.string().min(1).optional(), {
		group: 'Observability',
		description: 'The id of the channel each sign-up is posted to, such as `C0123456789`, at the bottom of the channel’s About pane.',
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
