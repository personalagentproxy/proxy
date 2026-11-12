import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * What a file or a folder may be called, and what a file is taken to hold by its name. A name is
 * one segment of a path, so it has no slash, and is never one of the two that mean a place rather
 * than a thing. The media type is read from the extension, since that is what whoever named the
 * file meant it to be, and a browser's or an agent's word for it is taken only where the name
 * says nothing.
 */

const MAX_NAME = 255;

const TEXT = 'text/plain';
const BYTES = 'application/octet-stream';

const TYPES: Record<string, string> = {
	txt: TEXT,
	log: TEXT,
	md: 'text/markdown',
	markdown: 'text/markdown',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	json: 'application/json',
	xml: 'application/xml',
	yaml: 'text/yaml',
	yml: 'text/yaml',
	toml: TEXT,
	ini: TEXT,
	ics: 'text/calendar',
	vcf: 'text/vcard',
	eml: 'message/rfc822',
	js: 'text/javascript',
	mjs: 'text/javascript',
	ts: TEXT,
	tsx: TEXT,
	jsx: TEXT,
	py: TEXT,
	rb: TEXT,
	go: TEXT,
	rs: TEXT,
	java: TEXT,
	c: TEXT,
	h: TEXT,
	cpp: TEXT,
	sh: TEXT,
	sql: TEXT,
	pdf: 'application/pdf',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	zip: 'application/zip',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	heic: 'image/heic',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
};

// A media type as a header may carry it: a type, a slash and a subtype, nothing a header ends at.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The folder at the top of a drive that the conversations' folders are in. */
export const CHATS_FOLDER = 'Chats';

/** A name, such as a persona's, as a folder's: its slashes made spaces; null where it can't be one. */
export function asFolderName(name: string): string | null {
	const named = requireFileName(name.replace(/[/\\]/g, ' '));
	return named.isOk() ? named.value : null;
}

/**
 * Where a conversation's files are kept in the person's own drive, as a path: the persona's folder
 * under Chats, where what the person attaches goes, and in it, for a sub-agent, one of its title's.
 */
export function chatFolder(persona: string, title: string | null): string {
	const own = [CHATS_FOLDER, asFolderName(persona) ?? 'Agent'].join('/');
	const task = title === null ? null : asFolderName(title);
	return task === null ? own : `${own}/${task}`;
}

/** A name as it is kept, trimmed; a validation error for one that can't be a file's. */
export function requireFileName(raw: string): Result<string, ApiError> {
	const name = raw.trim();
	if (name === '' || name === '.' || name === '..') {
		return Err(ApiErr.validationError('A file or a folder needs a name'));
	}
	if (name.length > MAX_NAME) {
		return Err(ApiErr.validationError(`A name is at most ${MAX_NAME} characters`));
	}
	// A slash would make it a path, and a control character shows as nothing.
	if (/[/\\]/.test(name) || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
		return Err(ApiErr.validationError('A name can’t have a slash or a line break in it'));
	}
	return Ok(name);
}

/**
 * What a file called `name` holds, as a media type: by its extension, else `said`, what whoever
 * sent it called it, where that is a media type, without its parameters, else `fallback`.
 */
export function mediaType(name: string, said: string | undefined, fallback: 'text' | 'bytes'): string {
	const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
	const byName = Object.hasOwn(TYPES, extension) ? TYPES[extension] : undefined;
	if (byName !== undefined) {
		return byName;
	}
	const given = said?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (MEDIA_TYPE.test(given) && given !== BYTES) {
		return given;
	}
	return fallback === 'text' ? TEXT : BYTES;
}

// The pictures a browser shows as they are, with nothing in them that runs: never SVG, which is a
// document with scripts of its own.
const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Whether a file of the type is a picture a browser may show in place, rather than download. */
export function isShownImage(type: string): boolean {
	return SHOWN.has(type);
}
