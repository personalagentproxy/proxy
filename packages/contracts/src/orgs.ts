import {isExperiment} from '@proxy/utils';
import {z} from 'zod';

/**
 * Organizations and their members (`/api/orgs/…`, `/api/invitations/…`): the switcher's list,
 * Members, Settings and invitations. An organization is named by its slug, its address in the app
 * and on the api.
 */

const roleSchema = z.enum(['owner', 'member']);

export const orgSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	role: roleSchema,
	/** Whether it has been through the welcome flow, or skipped it; the web app shows it until then. */
	onboarded: z.boolean(),
	/** The experiments on for it, for the web app's `useExperiments`; those it doesn't know are left out. */
	experiments: z.array(z.string()).transform((ids) => ids.filter(isExperiment)),
	memberCount: z.number(),
	/** Invitations not taken up yet. */
	invitationCount: z.number(),
});

export type Org = z.infer<typeof orgSchema>;

/**
 * `GET /api/orgs`: the person's organizations, the first one joined first. The experiments are
 * each organization's own page's to say (`GET /api/orgs/:org`); here they are left empty.
 */
export const orgListSchema = z.object({orgs: z.array(orgSchema)});

const MAX_NAME_LENGTH = 80;

/** `POST /api/orgs`, `PATCH /api/orgs/:org`: a new organization's name, or a new name for one. */
export const orgNameBodySchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'Give the organization a name')
		.max(MAX_NAME_LENGTH, `The name can be at most ${MAX_NAME_LENGTH} characters`),
});

export const memberSchema = z.object({
	userId: z.string(),
	name: z.string().nullable(),
	email: z.string(),
	image: z.string().nullable(),
	role: roleSchema,
	joinedAt: z.string(),
});

export type Member = z.infer<typeof memberSchema>;

export const invitationSchema = z.object({
	id: z.string(),
	email: z.string(),
	invitedBy: z.string().nullable(),
	expiresAt: z.string(),
});

export type Invitation = z.infer<typeof invitationSchema>;

/** `GET /api/orgs/:org/members`: who is in it and who is invited. */
export const memberListSchema = z.object({
	members: z.array(memberSchema),
	invitations: z.array(invitationSchema),
});

/** `POST /api/orgs/:org/invitations`: its owner invites someone by address. */
export const inviteBodySchema = z.object({email: z.string()});

/** `GET /api/invitations/:token`: what an invitation's link is for. */
export const invitationLinkSchema = z.object({
	orgId: z.string(),
	/** The organization's slug, its address in the web app. */
	orgSlug: z.string(),
	orgName: z.string(),
	invitedBy: z.string().nullable(),
	/** The address it was sent to. */
	email: z.string(),
	expired: z.boolean(),
	/** Whether the signed-in person is in the organization already. */
	member: z.boolean(),
});

export type InvitationLink = z.infer<typeof invitationLinkSchema>;

/** `POST /api/invitations/:token/accept`: the organization joined; its slug is where to go next. */
export const acceptedInvitationSchema = z.object({orgId: z.string(), orgSlug: z.string()});
