import {z} from 'zod';

import {fileMakerSchema} from './files';

/**
 * A member's memory, as the person reads it on its connection's page
 * (`/api/orgs/:org/connections/:connectionId/memory`): its notes, each whole, with the agents
 * that wrote it. A note's versions, writing one, giving an earlier one back and putting one in the
 * trash are the drive's routes (files.ts), its notes being kept as a drive's files are.
 */

export const memoryNoteSchema = z.object({
	id: z.string(),
	title: z.string(),
	/** Its first line, which every thread is given in the index. */
	summary: z.string(),
	content: z.string(),
	/** The version it holds now, which a write over it names. */
	version: z.string(),
	modifiedAt: z.string(),
	/** The agents that wrote it, the latest first; none where only the person did. */
	makers: z.array(fileMakerSchema),
	/** About you: the note every thread is given whole. */
	about: z.boolean(),
});

export type MemoryNote = z.infer<typeof memoryNoteSchema>;

/** `GET memory`: the notes, the latest changed first. */
export const memorySchema = z.object({notes: z.array(memoryNoteSchema)});

export type Memory = z.infer<typeof memorySchema>;
