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
 * One of the person's sessions in `GET /api/me/sessions`: where it signed in, read from its
 * User-Agent (`client` a browser's name or `Desktop app`, `os` the system, each null when the
 * header said nothing we know, or the session is older than keeping it), when, and whether it is
 * the one asking.
 */
export const sessionSchema = z.object({
	id: z.string(),
	client: z.string().nullable(),
	os: z.string().nullable(),
	createdAt: z.string(),
	current: z.boolean(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionsSchema = z.object({sessions: z.array(sessionSchema)});

export type Sessions = z.infer<typeof sessionsSchema>;

/**
 * How a member connected their Claude account on the Account page (`GET /api/me/claude`): a
 * sign-in to their Claude subscription, a token from `claude setup-token`, or an Anthropic API
 * key. The credential itself never comes back: `expiresAt` is a sign-in's access token's, which
 * the api refreshes itself, and `failure` why the last refresh was refused, until they connect
 * again.
 */
export const claudeAccountKindSchema = z.enum(['oauth', 'setup_token', 'api_key']);

export type ClaudeAccountKind = z.infer<typeof claudeAccountKindSchema>;

export const claudeAccountSchema = z.object({
	account: z
		.object({
			kind: claudeAccountKindSchema,
			email: z.string().nullable(),
			subscriptionType: z.string().nullable(),
			expiresAt: z.string().nullable(),
			failure: z.string().nullable(),
			connectedAt: z.string(),
		})
		.nullable(),
});

export type ClaudeAccount = z.infer<typeof claudeAccountSchema>;

/** `POST /api/me/claude/sign-in`: Claude's sign-in page, to open in a new tab; it shows a code to paste back. */
export const claudeSignInSchema = z.object({authorizeUrl: z.string()});

export type ClaudeSignIn = z.infer<typeof claudeSignInSchema>;

/** `POST /api/me/claude/code`: the code Claude showed, pasted as it was, `<code>#<state>`. */
export const claudeCodeBodySchema = z.object({code: z.string().trim().min(1).max(4096)});

/** `POST /api/me/claude/token`: a `claude setup-token` value or an Anthropic API key. */
export const claudeTokenBodySchema = z.object({token: z.string().trim().min(1).max(4096)});
