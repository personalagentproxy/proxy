import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Alerts page (`/api/orgs/:org/alerts`): the person's alerts, those the agents they talk with
 * on the Chat page set in their chats' threads, to be woken outside them: at a time, again and
 * again where it repeats, or a watch on a collection of some connections, which fires for each new
 * record there that carries any of its words. Each comes either to one thread, the one it was set
 * in, or to the chat, where it opens a new thread each time, as the agent chose. An alert is gone
 * once it fires, unless it repeats or is a watch, or when the agent or the person cancels it.
 */

/** Where an alert comes: into the thread it was set in, or into the chat, as a new thread each time. */
export const alertOpensSchema = z.enum(['this_thread', 'new_thread']);

export type AlertOpens = z.infer<typeof alertOpensSchema>;

/** How a watch that opens new threads splits what it finds: a thread for each look that found something, or one for each record. */
export const alertSplitSchema = z.enum(['per_check', 'per_record']);

export type AlertSplit = z.infer<typeof alertSplitSchema>;

/**
 * A thread an alert comes to or was set in: its id and title, and, for one that lives in Slack, its
 * link there, since the app doesn't show it; null for one in Chat, whose page is the app's.
 */
const threadRefSchema = z.object({
	id: z.string(),
	title: z.string(),
	slackUrl: z.string().nullable(),
});

export const alertSchema = z.object({
	id: z.string(),
	title: z.string(),
	/** What the agent noted for it: what to tell the person at the time, or what the watch is for. */
	brief: z.string(),
	/** The agent it was set with, in whose chat it is told. */
	persona: z.object({
		id: z.string(),
		name: z.string(),
		look: lookSchema,
		color: z.enum(AVATAR_COLORS),
	}),
	opens: alertOpensSchema,
	/** The thread it comes to, for one that opens none; null for one that opens a new thread each time. */
	thread: threadRefSchema.nullable(),
	/** The thread it was set in; null once that is gone. */
	setIn: threadRefSchema.nullable(),
	/** A timed alert's time, its next where it repeats; null for a watch. */
	at: z.string().nullable(),
	/** How a timed alert repeats, in words ("every week on Monday at 9:00 (Europe/Berlin)"); null for one that comes once, and for a watch. */
	every: z.string().nullable(),
	/** How a watch that opens new threads splits what it finds; null otherwise. */
	split: alertSplitSchema.nullable(),
	/** A watch: what it watches, in words ("emails"), the connections it watches, each with its integration, and the words it looks for; null and none for a timed alert. */
	collection: z.string().nullable(),
	connections: z.array(z.object({id: z.string(), integrationId: z.string(), name: z.string()})),
	terms: z.array(z.string()),
	/** When a watch last matched a record; null before the first match, and for a timed alert. */
	lastMatchedAt: z.string().nullable(),
	createdAt: z.string(),
});

export type Alert = z.infer<typeof alertSchema>;

/** `GET alerts`: the person's alerts in the organization, newest first. */
export const alertListSchema = z.object({alerts: z.array(alertSchema)});
