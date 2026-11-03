import {z} from 'zod';

/**
 * A collection's records, as the human side reads and writes them
 * (`/api/orgs/:org/connections/:connectionId/collections/:collectionId/records`) and as an agent's
 * list and record tools answer (`agent-side.ts`).
 */

/**
 * A record and, in a nested collection, whether it holds records of its own to list.
 */
export const dataRecordSchema = z.object({
	id: z.string(),
	values: z.record(z.string(), z.string()),
	updatedAt: z.string(),
	/**
	 * Where the person sees it in the provider's own app, as Gmail or Notion shows it, for an agent
	 * to hand them; a record without one has no page they can open.
	 */
	url: z.string().optional(),
	/** In a nested collection, whether it holds records of its own to list. */
	hasChildren: z.boolean().optional(),
});

export type DataRecord = z.infer<typeof dataRecordSchema>;

/** A record a list was opened in, or one above it. */
export const crumbSchema = z.object({id: z.string(), title: z.string()});

export type Crumb = z.infer<typeof crumbSchema>;

/**
 * One page of records, newest first, and the token of the next, older page if there is one. A
 * list opened in a record says where it is: that record last, those above it before it.
 */
export const recordPageSchema = z.object({
	records: z.array(dataRecordSchema),
	nextPage: z.string().nullable(),
	trail: z.array(crumbSchema).optional(),
});

export type RecordPage = z.infer<typeof recordPageSchema>;
