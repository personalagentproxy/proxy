import {z} from 'zod';

/**
 * Slack, for an organization with the `slack` experiment on: the Slack workspaces linked to it, and
 * a shared persona's own Slack app in one of them, which whoever may change the persona adds,
 * updates and removes from its settings; and a member's Slack account linked to them, which they
 * confirm from a link the app gives them, and unlink from their account.
 */

/**
 * A linked workspace, by its name as Slack last said it: whether Slack turned its token down, so
 * that a member has to paste one again before anything more is made or changed there, and whether
 * a persona's app is in it, which keeps it linked.
 */
export const slackWorkspaceSchema = z.object({
	id: z.string(),
	name: z.string(),
	needsToken: z.boolean(),
	inUse: z.boolean(),
});

export type SlackWorkspace = z.infer<typeof slackWorkspaceSchema>;

/**
 * Where a persona's app stands: made, and waiting to be installed or for a Slack admin to approve
 * it; in Slack; in Slack but made from an older manifest than ours, or with the persona's old name,
 * so to be updated; removed in Slack, uninstalled there or its token revoked.
 */
export const slackAppStateSchema = z.enum(['waiting', 'in_slack', 'out_of_date', 'removed']);

export type SlackAppState = z.infer<typeof slackAppStateSchema>;

export const slackAppSchema = z.object({
	state: slackAppStateSchema,
	workspaceId: z.string(),
	workspaceName: z.string(),
	/** The bot's handle in Slack, without the @, once installed. */
	handle: z.string().nullable(),
	/** Where the app's settings are in Slack, where its picture is set by hand; null before Slack has made it. */
	settingsUrl: z.string().nullable(),
});

export type SlackApp = z.infer<typeof slackAppSchema>;

/**
 * `GET /api/orgs/:org/chat/personas/:personaId/slack`: the persona's app, the workspaces it can be
 * added to, and, where it can't be added on this server at all, why.
 */
export const personaSlackSchema = z.object({
	workspaces: z.array(slackWorkspaceSchema),
	app: slackAppSchema.nullable(),
	unavailable: z.string().nullable(),
});

export type PersonaSlack = z.infer<typeof personaSlackSchema>;

/**
 * `GET /api/orgs/:org/chat/personas/:personaId/slack/presence`: where any member who sees the
 * persona writes to it in Slack, for one who may not change it: its handle, its workspace, and the
 * address that opens its messages there; null where it isn't installed in Slack.
 */
export const personaInSlackSchema = z.object({
	inSlack: z
		.object({handle: z.string(), workspaceName: z.string(), slackUrl: z.string()})
		.nullable(),
});

export type PersonaInSlack = z.infer<typeof personaInSlackSchema>;

/**
 * `POST /api/orgs/:org/slack/workspaces`: a workspace linked with a Slack app configuration token
 * and its refresh token, as Slack shows them together where they are generated.
 */
export const linkSlackWorkspaceBodySchema = z.object({
	token: z.string().trim().min(1),
	refreshToken: z.string().trim().min(1),
});

export const linkedSlackWorkspaceSchema = z.object({workspace: slackWorkspaceSchema});

/** `POST /api/orgs/:org/chat/personas/:personaId/slack`: the persona added to a linked workspace. */
export const addToSlackBodySchema = z.object({workspaceId: z.string().min(1)});

/**
 * The persona's app after it was made or updated; `install` where the person is to go through
 * Slack's install next (`/api/orgs/:org/chat/personas/:personaId/slack/install`, a top-level
 * navigation): after it is made, and after an update that asks for more than was granted.
 */
export const slackAppAnswerSchema = z.object({app: slackAppSchema, install: z.boolean()});

/**
 * What the page is told on coming back from Slack's install, as `?slack=` on the persona's chat:
 * installed; turned down there; installed across a whole Enterprise organization, which is
 * refused; installed in another workspace than the one it was made in; or anything else.
 */
export const slackInstallOutcomeSchema = z.enum([
	'installed',
	'denied',
	'enterprise',
	'workspace',
	'failed',
]);

export type SlackInstallOutcome = z.infer<typeof slackInstallOutcomeSchema>;

/**
 * `GET /api/slack-links/:token`: what the link a persona's app gave a Slack user linked to nobody
 * is for, as the page confirming who they are shows it to the person signed in: run out; for an
 * organization they aren't in, with its owner's name, whom to ask for an invitation; for a Slack
 * user linked to another member already; or to confirm, which links the Slack user to them in the
 * workspace, `linked` where it is so already. A link that isn't one is not found.
 */
export const slackConfirmationSchema = z.discriminatedUnion('state', [
	z.object({state: z.literal('expired')}),
	z.object({
		state: z.literal('not_member'),
		workspaceName: z.string(),
		orgName: z.string(),
		ownerName: z.string().nullable(),
	}),
	z.object({state: z.literal('taken'), workspaceName: z.string(), orgName: z.string()}),
	z.object({
		state: z.literal('confirm'),
		workspaceName: z.string(),
		orgName: z.string(),
		personaName: z.string(),
		linked: z.boolean(),
	}),
]);

export type SlackConfirmation = z.infer<typeof slackConfirmationSchema>;

/**
 * `POST /api/slack-links/:token`: the Slack user linked to the person signed in; whether the
 * message that prompted it was taken up, and where the app's DM is in Slack, to go back to.
 */
export const slackConfirmedSchema = z.object({
	personaName: z.string(),
	takenUp: z.boolean(),
	slackUrl: z.string(),
});

export type SlackConfirmed = z.infer<typeof slackConfirmedSchema>;

/** A Slack user the person is linked to, in one organization's workspace, as their account lists it, with when they confirmed it. */
export const slackMemberLinkSchema = z.object({
	id: z.string(),
	workspaceName: z.string(),
	orgName: z.string(),
	createdAt: z.string(),
});

export type SlackMemberLink = z.infer<typeof slackMemberLinkSchema>;

/** `GET /api/me/slack-links`: the Slack users the person is linked to, in every organization. */
export const slackMemberLinksSchema = z.object({links: z.array(slackMemberLinkSchema)});
