import {Err} from 'ts-results-es';

import {ApiErr, Do} from '@proxy/utils';

import {type DataRecord, type RecordStore, requireFirstPage} from '../../records/connector';
import {matches, type Note, readNotes, writtenBy} from './notes';

/**
 * A memory's notes as records, only read here: the list with each note's summary, searched by
 * the words in its title and text, and a note opened whole, with the version memory_write has to
 * name to change it. Every write is a tool of the integration's own (tools.ts), which names who
 * wrote it.
 */

function toRecord(note: Note, content: string): DataRecord {
	const modified = note.modifiedAt.toISOString();
	return {
		id: note.id,
		values: {title: note.title, summary: note.summary, content, version: note.version, writtenBy: writtenBy(note), modified},
		updatedAt: modified,
	};
}

/** The notes collection's connector. */
export const memoryConnector = {
	list: (target, query) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			const notes = $(await readNotes(target.connection.id));
			const search = query.search?.trim();
			const found = search ? notes.filter((note) => matches(note, search)) : notes;
			return {records: found.map((note) => toRecord(note, '')), nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const notes = $(await readNotes(target.connection.id));
			const note = notes.find((candidate) => candidate.id === recordId);
			if (!note) {
				return $(Err(ApiErr.notFound('note', recordId, 'notes_list lists them.')));
			}
			return toRecord(note, note.content);
		}),
} satisfies RecordStore;
