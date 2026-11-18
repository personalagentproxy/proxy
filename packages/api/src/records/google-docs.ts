import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {getDocument, updateDocument, type DocumentRequest, type StructuralElement, type TextStyle} from '../connections/google/docs-api';
import {fileIdOf} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import type {NativeToolRun, NativeToolRunner} from '../native/tool';
import {changeBy, changeDriveFile, loggedAs, type DriveEditor} from './google-history';

/**
 * A Google Doc's text, read and edited in place through the Docs API, rather than replaced whole
 * from Markdown as the files record does, so its comments, suggestions and formatting stay.
 *
 * `docs_read` answers the text of the document's body as the Docs API presents it, paragraph by
 * paragraph, those in tables' cells too, with the revision it was read at. `docs_edit` makes edits
 * to it, each found by text that must appear exactly once in the body: replaced, written before or
 * after, or styled. Matches are turned into the document's own positions here, in UTF-16 code
 * units as Docs counts them, and the edits sent in one batch, back to front so none moves
 * another's place, made by Docs only to the revision the agent read: on a read of an older one,
 * they are turned down, and the agent reads the document again.
 *
 * Text is found within the body's text as it runs on, across the runs a paragraph's styles split
 * it into and across paragraphs, but never across what isn't text: an image, a chip, or the edges
 * of a table and its cells. A table of contents, which Docs writes itself, and headers, footers
 * and footnotes are left out. A document with several tabs is read and edited in its first.
 *
 * An edit goes through the document's history (google-history.ts): a copy of it kept before a
 * task's first change, and logged as an edit, with Drive's revisions before and after.
 */

// What stands in the body's text for whatever there isn't text: an image, a chip, the edges of a
// table and of its cells. No text found holds it, so a find never reaches across one.
const NOT_TEXT = '￼';

// The most edits made at once.
const MAX_EDITS = 100;

/** A document's body: its text, each UTF-16 code unit at its own position, `NOT_TEXT` where no text is, and its paragraphs' places in it. */
type Body = {text: string; paragraphs: {start: number; end: number}[]};

// A body's paragraphs, in order, those in a table's cells among them; a table of contents', which
// Docs writes itself, left out.
function paragraphsOf(content: StructuralElement[]): StructuralElement[] {
	return content.flatMap((element) => {
		if (element.paragraph) {
			return [element];
		}
		const cells = (element.table?.tableRows ?? []).flatMap((row) => row.tableCells ?? []);
		return cells.flatMap((cell) => paragraphsOf(cell.content ?? []));
	});
}

function bodyOf(content: StructuralElement[]): Body {
	const paragraphs = paragraphsOf(content);
	const runs = paragraphs.flatMap((paragraph) =>
		(paragraph.paragraph?.elements ?? []).flatMap((part) => (part.textRun?.content === undefined ? [] : [{start: part.startIndex ?? 0, text: part.textRun.content}])),
	);
	let text = '';
	for (const run of runs) {
		if (run.start < text.length) {
			continue;
		}
		text += NOT_TEXT.repeat(run.start - text.length) + run.text;
	}
	const end = content.reduce((last, element) => Math.max(last, element.endIndex ?? 0), text.length);
	return {text: text.padEnd(end, NOT_TEXT), paragraphs: paragraphs.map((paragraph) => ({start: paragraph.startIndex ?? 0, end: paragraph.endIndex ?? 0}))};
}

/** The body's text as `docs_read` answers it: its paragraphs one after another, each ending with its line break. */
function readableText(body: Body): string {
	return body.paragraphs.map(({start, end}) => body.text.slice(start, end)).join('');
}

// Where `find` starts in the text, every place, those overlapping another too.
function placesOf(text: string, find: string): number[] {
	const places: number[] = [];
	for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) {
		places.push(at);
	}
	return places;
}

// A tool's params read against its schema; what is wrong is said with the tool's own params named.
function read<T>(schema: z.ZodType<T>, tool: string, takes: string, params: Record<string, unknown>): Result<T, ApiError> {
	const parsed = schema.safeParse(params);
	if (!parsed.success) {
		return Err(ApiErr.validationError(`${tool} takes ${takes}:\n${z.prettifyError(parsed.error)}`));
	}
	return Ok(parsed.data);
}

function requireDocId(given: string): Result<string, ApiError> {
	return requirePresent(fileIdOf(given), ApiErr.validationError('Say which document as id: its id, as files_list gives it, or its link'));
}

function editorOf(run: NativeToolRun, token: string): DriveEditor {
	return {token, change: changeBy(run.connection, {agentId: run.caller.agent.agentId, taskId: run.caller.taskId})};
}

function linkOf(documentId: string): string {
	return `https://docs.google.com/document/d/${documentId}/edit`;
}

const idSchema = z.object({id: z.string().min(1)});

/** `docs_read`: a Doc's text, as `docs_edit` finds text in it, and the revision it was read at. */
export const runDocsRead: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(idSchema, 'docs_read', 'id', run.params));
		const documentId = $(requireDocId(id));
		const document = $(await callGoogle(run.connection, (token) => getDocument(token, documentId)));
		const text = readableText(bodyOf(document.content));
		const notText = text.includes(NOT_TEXT) ? [`${NOT_TEXT} stands for what isn’t text, as an image or a chip; no find reaches across one.`] : [];
		return [`“${document.title}”, at revision ${document.revisionId}, which docs_edit takes as revision.`, `Link: ${linkOf(documentId)}`, ...notText, '', text].join('\n');
	});

// Docs' paragraph styles, as its menu names them.
const HEADINGS = {
	'Normal text': 'NORMAL_TEXT',
	Title: 'TITLE',
	Subtitle: 'SUBTITLE',
	'Heading 1': 'HEADING_1',
	'Heading 2': 'HEADING_2',
	'Heading 3': 'HEADING_3',
	'Heading 4': 'HEADING_4',
	'Heading 5': 'HEADING_5',
	'Heading 6': 'HEADING_6',
} as const;

type Heading = keyof typeof HEADINGS;

const HEADING_NAMES = Object.keys(HEADINGS) as [Heading, ...Heading[]];

const styleSchema = z.strictObject({
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
	underline: z.boolean().optional(),
	link: z.string().optional(),
	heading: z.enum(HEADING_NAMES).optional(),
});

type Style = z.infer<typeof styleSchema>;

const editSchema = z.strictObject({
	find: z.string().min(1),
	replace: z.string().optional(),
	insertBefore: z.string().min(1).optional(),
	insertAfter: z.string().min(1).optional(),
	style: styleSchema.optional(),
});

const docsEditSchema = z.object({id: z.string().min(1), revision: z.string().min(1), edits: z.array(editSchema).min(1).max(MAX_EDITS)});

/** One edit, as it was asked for: what it finds, and what it does there. */
type Edit = {find: string} & ({kind: 'replace' | 'insertBefore' | 'insertAfter'; text: string} | {kind: 'style'; style: Style});

const EDIT_TAKES = 'find, and one of replace, insertBefore, insertAfter or style';

// An edit's place in the list, as an agent counts.
function nth(index: number): string {
	return `Edit ${index + 1}`;
}

function editOf(given: z.infer<typeof editSchema>, index: number): Result<Edit, ApiError> {
	const {find, ...made} = given;
	if (find.includes(NOT_TEXT)) {
		return Err(ApiErr.validationError(`${nth(index)}’s find holds ${NOT_TEXT}, which stands for what isn’t text: find text on one side of it`));
	}
	const kinds = Object.keys(made);
	if (kinds.length !== 1) {
		return Err(ApiErr.validationError(`${nth(index)} takes ${EDIT_TAKES}, not ${kinds.length === 0 ? 'find alone' : kinds.join(' and ')}`));
	}
	if (made.style !== undefined) {
		return styleEdit(find, made.style, index);
	}
	if (made.insertBefore !== undefined) {
		return Ok({find, kind: 'insertBefore', text: made.insertBefore});
	}
	if (made.insertAfter !== undefined) {
		return Ok({find, kind: 'insertAfter', text: made.insertAfter});
	}
	return Ok({find, kind: 'replace', text: made.replace ?? ''});
}

function styleEdit(find: string, style: Style, index: number): Result<Edit, ApiError> {
	if (Object.keys(style).length === 0) {
		return Err(ApiErr.validationError(`${nth(index)}’s style sets nothing: give bold, italic, underline, link or heading`));
	}
	if (style.link !== undefined && style.link !== '' && !URL.canParse(style.link)) {
		return Err(ApiErr.validationError(`${nth(index)}’s link isn’t a web address: give it whole, as https://example.com/page, or "" to take a link off`));
	}
	return Ok({find, kind: 'style', style});
}

/** An edit and the one place in the body its find is, from `start` up to `end`. */
type Located = {edit: Edit; index: number; start: number; end: number};

// Where an edit's find is in the body, or why it can't be told: it appears nowhere, or more than once.
function locate(body: Body, edit: Edit, index: number): Result<Located, string> {
	const places = placesOf(body.text, edit.find);
	const [start] = places;
	if (start === undefined) {
		return Err(
			`${nth(index)}: “${edit.find}” appears nowhere in the document. find matches the text as docs_read answers it, exactly, its case too, and never across an image, a chip or a table’s cells.`,
		);
	}
	if (places.length > 1) {
		return Err(`${nth(index)}: “${edit.find}” appears ${places.length} times in the document. Make find longer, with the words around it, so it appears once.`);
	}
	const end = start + edit.find.length;
	if (edit.kind === 'replace' && end === body.text.length) {
		return Err(`${nth(index)}: the line break that ends the document can’t be replaced. Leave it out of find.`);
	}
	return Ok({edit, index, start, end});
}

// Every edit's place, refused where any can't be told, or two touch the same text.
function locateAll(body: Body, edits: Edit[]): Result<Located[], ApiError> {
	const results = edits.map((edit, index) => locate(body, edit, index));
	const problems = results.flatMap((result) => (result.isErr() ? [result.error] : []));
	if (problems.length > 0) {
		return Err(ApiErr.validationError(`No edit was made:\n${problems.join('\n')}`));
	}
	const located = results.flatMap((result) => (result.isOk() ? [result.value] : [])).toSorted((one, other) => one.start - other.start);
	const overlaps = located.flatMap((place, at) => {
		const next = located[at + 1];
		return next !== undefined && place.end > next.start ? [[place, next] as const] : [];
	});
	const [first] = overlaps;
	if (first !== undefined) {
		const [one, other] = first;
		return Err(ApiErr.validationError(`No edit was made: ${nth(Math.min(one.index, other.index))} and ${nth(Math.max(one.index, other.index))} find the same text. Make them one edit.`));
	}
	return Ok(located);
}

function rangeOf(start: number, end: number): {startIndex: number; endIndex: number} {
	return {startIndex: start, endIndex: end};
}

// The changes a style makes to the text found: the runs' style, and the heading of the paragraphs it is in.
function styleRequests({style, start, end}: {style: Style; start: number; end: number}): DocumentRequest[] {
	const textStyle: TextStyle = {};
	const fields: string[] = [];
	for (const key of ['bold', 'italic', 'underline'] as const) {
		const value = style[key];
		if (value !== undefined) {
			textStyle[key] = value;
			fields.push(key);
		}
	}
	if (style.link !== undefined) {
		fields.push('link');
	}
	if (style.link) {
		textStyle.link = {url: style.link};
	}
	const text: DocumentRequest[] = fields.length === 0 ? [] : [{updateTextStyle: {range: rangeOf(start, end), textStyle, fields: fields.join(',')}}];
	const paragraph: DocumentRequest[] =
		style.heading === undefined ? [] : [{updateParagraphStyle: {range: rangeOf(start, end), paragraphStyle: {namedStyleType: HEADINGS[style.heading]}, fields: 'namedStyleType'}}];
	return [...text, ...paragraph];
}

function insertText(index: number, text: string): DocumentRequest {
	return {insertText: {location: {index}, text}};
}

function deleteRange(start: number, end: number): DocumentRequest {
	return {deleteContentRange: {range: rangeOf(start, end)}};
}

/**
 * Text found replaced: the new text written just after the found text's first character, then
 * the rest of the found text and that character deleted, so the new text takes the style of the
 * text it replaces, as Docs' own find and replace does, rather than of the text before it.
 */
function replaceRequests(body: Body, start: number, end: number, text: string): DocumentRequest[] {
	if (text === '') {
		return [deleteRange(start, end)];
	}
	const first = (body.text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
	const after = start + first;
	const rest = end > after ? [deleteRange(after + text.length, end + text.length)] : [];
	return [insertText(after, text), ...rest, deleteRange(start, after)];
}

// The changes one edit makes to the text, at its place: none for a style, which changes no place.
function textRequests(body: Body, {edit, start, end}: Located): DocumentRequest[] {
	if (edit.kind === 'style') {
		return [];
	}
	if (edit.kind === 'insertBefore') {
		return [insertText(start, edit.text)];
	}
	if (edit.kind === 'insertAfter') {
		return [insertText(end, edit.text)];
	}
	return replaceRequests(body, start, end, edit.text);
}

/**
 * The batch of changes the edits make: the styles first, which move no text, then the text,
 * back to front, so every place is still where it was found.
 */
function requestsFor(body: Body, edits: Edit[]): Result<DocumentRequest[], ApiError> {
	return locateAll(body, edits).map((located) => {
		const styles = located.flatMap(({edit, start, end}) => (edit.kind === 'style' ? styleRequests({style: edit.style, start, end}) : []));
		const texts = located.toReversed().flatMap((place) => textRequests(body, place));
		return [...styles, ...texts];
	});
}

function staleText(revision: string): string {
	return `The document changed since revision ${revision} was read, or that revision is too old: no edit was made. Read it again with docs_read, and make the edits on what it holds now, with its new revision.`;
}

/** What `docs_edit` did: the document's title, and the revision it is at now, where Docs said. */
type Edited = {title: string; revision: string | null};

// The document read, the edits turned into its positions, and made, only to the revision read, through its history.
function editDocument(editor: DriveEditor, documentId: string, revision: string, edits: Edit[]): Promise<Result<Edited, ApiError>> {
	return Do(async ($) => {
		const document = $(await getDocument(editor.token, documentId));
		const requests = $(requestsFor(bodyOf(document.content), edits));
		const after = $(await changeDriveFile(editor, documentId, {content: true}, () => loggedAs({kind: 'edit'}, updateDocument(editor.token, documentId, requests, revision, staleText(revision)))));
		return {title: document.title, revision: after};
	});
}

/** `docs_edit`: edits made to a Doc's text, each at the one place its find appears, only to the revision the agent read. */
export const runDocsEdit: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(read(docsEditSchema, 'docs_edit', `id, revision and edits, each ${EDIT_TAKES}`, run.params));
		const documentId = $(requireDocId(params.id));
		const edits: Edit[] = [];
		for (const [index, given] of params.edits.entries()) {
			edits.push($(editOf(given, index)));
		}
		const edited = $(await callGoogle(run.connection, (token) => editDocument(editorOf(run, token), documentId, params.revision, edits)));
		const count = edits.length === 1 ? 'the edit' : `all ${edits.length} edits`;
		const next =
			edited.revision === null ? 'Read it again with docs_read for its new revision before editing it again.' : `It is at revision ${edited.revision} now, which docs_edit takes for more edits.`;
		return [`Made ${count} to “${edited.title}”. ${next}`, `Link: ${linkOf(documentId)}`].join('\n');
	});
