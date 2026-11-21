import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {MEMORY_ABOUT_CHARACTERS, MEMORY_ABOUT_TITLE, MEMORY_NOTE_CHARACTERS, MEMORY_SUMMARY_CHARACTERS} from '@proxy/integrations';
import {type FileMaker, listFileMakers, listTopFiles, type TopFile} from '@proxy/db/files';

import {requireFileName} from '../files/names';
import {readVersion} from '../files/text';

/**
 * A member's memory as notes: each a file at the top of its connection's drive, called by its
 * title and .md, holding Markdown whose first line is its summary. Read whole here, all of them
 * at once, since there are few and they are short: to search them, and for what every thread is
 * given (mcp/tools.ts). Who wrote a note is its file's journal's, as a drive's is (db/files.ts).
 */

/** How many notes are read at most, the latest changed first. */
export const MAX_NOTES = 500;

/** How long a title may be. */
const MAX_TITLE = 120;

/** A note as it is now, with the agents that wrote it, the latest first. */
export type Note = {id: string; title: string; summary: string; content: string; version: string; modifiedAt: Date; makers: FileMaker[]};

const EXTENSION = '.md';

/** A note's title, from its file's name. */
export function titleOf(name: string): string {
	return name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : name;
}

/** Whether the title is the note every thread is given whole. */
export function isAbout(title: string): boolean {
	return title.trim().toLowerCase() === MEMORY_ABOUT_TITLE.toLowerCase();
}

/** The file a title is kept as, About you by its own spelling however it was written; refused where it can't be a file's name. */
export function nameOf(title: string): Result<string, ApiError> {
	const trimmed = title.trim();
	if (trimmed === '') {
		return Err(ApiErr.validationError('A note needs a title'));
	}
	if (trimmed.length > MAX_TITLE) {
		return Err(ApiErr.validationError(`A note’s title is at most ${MAX_TITLE} characters`));
	}
	return requireFileName(`${isAbout(trimmed) ? MEMORY_ABOUT_TITLE : trimmed}${EXTENSION}`);
}

/** A note's summary: its first line with words in it, without a heading's marks, cut short where long. */
export function summaryOf(content: string): string {
	const line = content.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
	const plain = line.replace(/^\s*#+\s*/, '').trim();
	return plain.length > MEMORY_SUMMARY_CHARACTERS ? `${plain.slice(0, MEMORY_SUMMARY_CHARACTERS - 1)}…` : plain;
}

/** What a note may hold: something, and no more than its title allows. */
export function requireContent(title: string, content: string): Result<void, ApiError> {
	if (content.trim() === '') {
		return Err(ApiErr.validationError('A note needs content: memory_forget forgets one'));
	}
	const most = isAbout(title) ? MEMORY_ABOUT_CHARACTERS : MEMORY_NOTE_CHARACTERS;
	if (content.length > most) {
		return Err(ApiErr.validationError(`That is ${content.length} characters, and “${title.trim()}” holds at most ${most}: shorten it, moving detail into notes of its own`));
	}
	return Ok(undefined);
}

// A file's text as a note's; a file that can't be read as text, which nothing here writes, has none.
function readNote(file: TopFile): Promise<Result<Omit<Note, 'makers'>, ApiError>> {
	return Do(async ($) => {
		const reading = $(await readVersion(file.name, file.head));
		const content = 'text' in reading ? reading.text : '';
		return {id: file.id, title: titleOf(file.name), summary: summaryOf(content), content, version: file.head.id, modifiedAt: file.updatedAt};
	});
}

/** Every note of the memory, the latest changed first, at most MAX_NOTES. */
export function readNotes(connectionId: string): Promise<Result<Note[], ApiError>> {
	return Do(async ($) => {
		const files = $(await listTopFiles(connectionId, MAX_NOTES));
		const [read, makers] = await Promise.all([
			Promise.all(files.map(readNote)),
			listFileMakers(
				connectionId,
				files.map((file) => file.id),
			),
		]);
		const byFile = $(makers);
		return read.map((note) => {
			const value = $(note);
			return {...value, makers: byFile.get(value.id) ?? []};
		});
	});
}

/** Whether a note has every word of a search in its title or its text, in any case. */
export function matches(note: Note, search: string): boolean {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	const text = `${note.title}\n${note.content}`.toLowerCase();
	return words.every((word) => text.includes(word));
}

/** Who wrote a note, in words: its agents, the latest first, or the person where none did. */
export function writtenBy(note: Note): string {
	if (note.makers.length === 0) {
		return 'the person';
	}
	return note.makers.map((maker) => maker.name).join(', ');
}
