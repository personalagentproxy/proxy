import {z} from 'zod';

/** `GET /api/me`: who is signed in. The organizations they are in are `GET /api/orgs` (`orgs.ts`). */
export const meSchema = z.object({
	user: z.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		image: z.string().nullable(),
	}),
});

export type Me = z.infer<typeof meSchema>;

/**
 * One of the person's sessions in `GET /api/me/sessions`: what it is, read from the User-Agent it
 * was last used with (`client` a browser's name or `Desktop app`, `os` the system, each null when
 * the header said nothing we know, and `version` the desktop app's, null for a browser), when it
 * signed in, and whether it is the one asking.
 */
export const sessionSchema = z.object({
	id: z.string(),
	client: z.string().nullable(),
	os: z.string().nullable(),
	version: z.string().nullable(),
	createdAt: z.string(),
	current: z.boolean(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionsSchema = z.object({sessions: z.array(sessionSchema)});

export type Sessions = z.infer<typeof sessionsSchema>;

/**
 * How a member connected their Claude account on the Account page (`GET /api/me/claude`): a
 * long-lived token, minted by the desktop app as `claude setup-token` would or pasted from that
 * command, or an Anthropic API key. The credential itself never comes back: `expiresAt` is when
 * the token ends as the mint reported it, null for a pasted token whose end isn't known and for a
 * key; `failure` why the credential was refused or that it ran out, until they connect again; and
 * `usage` what the model's provider said of their plan as the last turn ran, each window the share
 * of it used, 0 to 1, with when it resets, as of `readAt`, or null before any turn said.
 */
export const claudeAccountKindSchema = z.enum(['setup_token', 'api_key']);

export type ClaudeAccountKind = z.infer<typeof claudeAccountKindSchema>;

const claudeUsageWindowSchema = z
	.object({utilization: z.number(), resetsAt: z.string().nullable()})
	.nullable();

export const claudeAccountSchema = z.object({
	account: z
		.object({
			kind: claudeAccountKindSchema,
			expiresAt: z.string().nullable(),
			failure: z.string().nullable(),
			connectedAt: z.string(),
			usage: z
				.object({
					fiveHour: claudeUsageWindowSchema,
					sevenDay: claudeUsageWindowSchema,
					readAt: z.string(),
				})
				.nullable(),
		})
		.nullable(),
});

export type ClaudeAccount = z.infer<typeof claudeAccountSchema>;

/**
 * `POST /api/me/claude/token`: a `claude setup-token` value or an Anthropic API key, with when the
 * token ends where the sender knows it, as the desktop app does of a token it minted.
 */
export const claudeTokenBodySchema = z.object({
	token: z.string().trim().min(1).max(4096),
	expiresAt: z.iso.datetime().optional(),
});
