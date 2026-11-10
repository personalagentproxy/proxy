import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {FILES_READ_CHARACTERS} from '@proxy/integrations';
import type {FileBlobRow, FileFound, FileVersionRow} from '@proxy/db/files';

import {fileText, readableKind} from '../../records/attachment-text';
import {readContent} from './content';

/**
 * A file as an agent reads it: its text, where what it holds can be read as text, as an email's
 * attachment is (records/attachment-text.ts): text as it is, a spreadsheet's tabs as CSV, a
 * PDF's or a Word document's text. Anything else, a picture among them, has no text, and the
 * answer says what it is instead. A long text is read a stretch at a time, each read saying where
 * the next goes on from. Nothing is kept of a reading: a PDF is read again each time.
 */

/** A version's text, or why it has none to read. */
export type Reading = {text: string} | {why: string};

/** Where a file is, from the top of its drive: "Reports/2026/q3.pdf". */
export function pathOf(file: FileFound): string {
	return [...file.trail.map((folder) => folder.name), file.name].join('/');
}

function whyOf(error: ApiError): string | null {
	return error.kind === 'validation_error' ? error.message : null;
}

/** What a version of the file called `name` holds, read as text; one that isn't text, or is too large to read, says so rather than failing. */
export function readVersion(name: string, version: FileVersionRow & {blob: FileBlobRow}): Promise<Result<Reading, ApiError>> {
	return Do(async ($): Promise<Reading> => {
		const info = {name, type: version.type, size: version.size};
		const kind = readableKind(info);
		const refused = kind.isErr() ? whyOf(kind.error) : null;
		if (refused !== null) {
			return {why: refused};
		}
		$(kind);
		const bytes = $(await readContent(version.blob));
		const text = await fileText({...info, bytes});
		const unread = text.isErr() ? whyOf(text.error) : null;
		if (unread !== null) {
			return {why: unread};
		}
		return {text: $(text)};
	});
}

/** A stretch of a text from the character `from`, and what to say of it: how much of the whole it is, and where to read on. */
export function stretch(text: string, from: number): {content: string; length: string} {
	const start = Math.min(Math.max(0, Math.floor(from)), text.length);
	const end = Math.min(start + FILES_READ_CHARACTERS, text.length);
	const whole = start === 0 && end === text.length;
	const rest = end < text.length ? ` Read on with files_read from ${end}.` : '';
	return {content: text.slice(start, end), length: whole ? `${text.length} characters` : `Characters ${start} to ${end} of ${text.length}.${rest}`};
}

/** What a file is, in a line: for one with no text to show. */
export function describeUnread(version: FileVersionRow, why: string): string {
	return `(${version.type}, ${formatBytes(version.size)}. ${why})`;
}
