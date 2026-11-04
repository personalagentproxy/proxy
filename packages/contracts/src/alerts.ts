import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Alerts page (`/api/orgs/:org/alerts`): the person's alerts, those the agents they talk with
 * on the Chat page set in their conversations, to be woken outside them: at a time, or a watch on a
 * collection of some connections, which fires for each new record there that carries any of its
 * words. An alert is gone once it fires, or when the agent or the person cancels it.
 */

export const alertSchema = z.object({
	id: z.string(),
	title: z.string(),
	/** What the agent noted for it: what to tell the person at the time, or what the watch is for. */
	brief: z.string(),
	/** The agent it was set with, whose conversation it is told in. */
	persona: z.object({
		id: z.string(),
		name: z.string(),
		look: lookSchema,
		color: z.enum(AVATAR_COLORS),
	}),
	/** A timed alert's time; null for a watch. */
	at: z.string().nullable(),
	/** A watch: what it watches, in words ("emails"), the connections it watches, and the words it looks for; null and none for a timed alert. */
	collection: z.string().nullable(),
	connections: z.array(z.object({id: z.string(), name: z.string()})),
	terms: z.array(z.string()),
	/** When a watch last matched a record; null before the first match, and for a timed alert. */
	lastMatchedAt: z.string().nullable(),
	createdAt: z.string(),
});

export type Alert = z.infer<typeof alertSchema>;

/** `GET alerts`: the person's alerts in the organization, newest first. */
export const alertListSchema = z.object({alerts: z.array(alertSchema)});
