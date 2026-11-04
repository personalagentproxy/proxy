import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Alerts page (`/api/orgs/:org/alerts`): the person's alerts, those the agents they talk with
 * on the Chat page set in their conversations, to be woken outside them: at a time, or a watch on
 * a collection of some connections, which fires for each new record that says what its criteria
 * ask. Going and ended, each with the agent it was set with and, for a watch, what it matched.
 */

/** How an alert ended: it fired, the agent ended it, the connection it watched is gone, or its job couldn't run. */
export const alertEndSchema = z.enum(['fired', 'agent', 'connection_gone', 'failed']);

export type AlertEnd = z.infer<typeof alertEndSchema>;

/** One condition of a watch: the field contains any of the terms. */
export const conditionSchema = z.object({field: z.string(), terms: z.array(z.string())});

/** A record a watch matched. */
export const alertMatchSchema = z.object({
	id: z.string(),
	title: z.string(),
	/** The record's fields that were read, in a line. */
	summary: z.string(),
	url: z.string().nullable(),
	at: z.string(),
});

export type AlertMatch = z.infer<typeof alertMatchSchema>;

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
	/** A watch: the collection watched, its criteria and the connections it watches; null, none and none for a timed alert. */
	collectionId: z.string().nullable(),
	criteria: z.array(conditionSchema),
	connections: z.array(z.object({id: z.string(), name: z.string()})),
	/** A watch: when its connections were last looked at, and what the last look failed with, where it did. */
	lastPolledAt: z.string().nullable(),
	pollError: z.string().nullable(),
	/** A watch's matches: how many, and the latest few, newest first. */
	matchCount: z.number(),
	matches: z.array(alertMatchSchema),
	endedAt: z.string().nullable(),
	endedBy: alertEndSchema.nullable(),
	createdAt: z.string(),
});

export type Alert = z.infer<typeof alertSchema>;

/** `GET alerts`: the person's alerts in the organization, newest first. */
export const alertListSchema = z.object({alerts: z.array(alertSchema)});
