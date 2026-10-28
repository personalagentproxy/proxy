import {simpleParser} from 'mailparser';
import mammoth from 'mammoth';
import {extractText, getDocumentProxy} from 'unpdf';
import * as XLSX from 'xlsx';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {decodeText} from '../utils/decode-text';
import {htmlToText} from '../utils/html-to-text';
import type {DataRecord, RecordValues} from './connector';

/**
 * An email's attachments as the `attachments` collection, the same for Gmail and any mailbox:
 * never listed or opened, only read, one at a time, by the email's id and the attachment's number
 * among the email's attachments, as an email lists them, or its name. An attachment is read as
 * text: a spreadsheet's tabs as CSV, one after the other, a PDF's or a Word document's text, an
 * email's headers and text, and text as it is. Anything else, such as an image, is turned down.
 */

/** An attachment as an email lists it. */
export type AttachmentInfo = {name: string; type: string; size: number};

/** An attachment with its content. */
export type AttachmentFile = AttachmentInfo & {bytes: Uint8Array};

// The characters of an attachment's text answered at most, as a web page's are.
const MAX_CHARACTERS = 100_000;

// The largest attachment read: Gmail's own limit on what an email carries.
const MAX_BYTES = 25 * 1024 * 1024;

function sizeText(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An email's attachments, one a line, numbered as they are read by: "1. Q3.xlsx (application/…, 48 KB)". */
export function attachmentsText(attachments: AttachmentInfo[]): string {
	return attachments.map((attachment, index) => `${index + 1}. ${attachment.name || 'Untitled'} (${attachment.type || 'unknown type'}, ${sizeText(attachment.size)})`).join('\n');
}

/** The attachment `values.attachment` names, by its number or its name, and its number. */
export function pickAttachment<T extends AttachmentInfo>(attachments: T[], values: RecordValues): Result<{attachment: T; number: number}, ApiError> {
	const which = (values.attachment ?? '').trim();
	if (attachments.length === 0) {
		return Err(ApiErr.validationError('This email has no attachments'));
	}
	const listed = `Its attachments are:\n${attachmentsText(attachments)}`;
	if (which === '') {
		return Err(ApiErr.validationError(`Say which attachment as attachment: its number or its name. ${listed}`));
	}
	const byNumber = /^\d+$/.test(which) ? Number(which) - 1 : -1;
	const byName = attachments.findIndex((attachment) => attachment.name === which);
	const index = [byNumber, byName, attachments.findIndex((attachment) => attachment.name.toLowerCase() === which.toLowerCase())].find((candidate) => candidate >= 0 && candidate < attachments.length);
	const attachment = index === undefined ? undefined : attachments[index];
	if (index === undefined || !attachment) {
		return Err(ApiErr.validationError(`This email has no attachment “${which}”. ${listed}`));
	}
	return Ok({attachment, number: index + 1});
}

/** The email `values.email` names, by its id as a list gives it. */
export function requireEmailId(values: RecordValues): Result<string, ApiError> {
	const id = (values.email ?? '').trim();
	if (id === '') {
		return Err(ApiErr.validationError('Say which email as email: its id, as a list gives it'));
	}
	return Ok(id);
}

type Kind = 'spreadsheet' | 'pdf' | 'word' | 'email' | 'html' | 'text';

const EXTENSIONS: Array<[Kind, string[]]> = [
	['spreadsheet', ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers']],
	['pdf', ['pdf']],
	['word', ['docx']],
	['email', ['eml']],
	['html', ['html', 'htm']],
	['text', ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'ics', 'vcf', 'log', 'yaml', 'yml']],
];

const TYPES: Array<[Kind, RegExp]> = [
	['spreadsheet', /^application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.|vnd\.ms-excel|vnd\.oasis\.opendocument\.spreadsheet)/],
	['pdf', /^application\/pdf$/],
	['word', /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/],
	['email', /^message\/rfc822$/],
	['html', /^text\/html$/],
	['text', /^(text\/|application\/(json|xml|csv)$)/],
];

// What a file is by its name first, since mail clients often send any file as
// application/octet-stream, then by its type.
function kindOf(file: AttachmentInfo): Kind | null {
	const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
	const byName = EXTENSIONS.find(([, extensions]) => extensions.includes(extension))?.[0];
	if (byName) {
		return byName;
	}
	return TYPES.find(([, pattern]) => pattern.test(file.type.toLowerCase()))?.[0] ?? null;
}

function unreadable(file: AttachmentInfo, cause: unknown): ApiError {
	const why = cause instanceof Error ? `: ${cause.message}` : '';
	return ApiErr.validationError(`“${file.name}” couldn’t be read${why}`);
}

// A date as 2026-03-01, with its time where it has one: 2026-03-01 14:30.
function dateText(date: Date): string {
	const [day = '', time = ''] = date.toISOString().split('T');
	return time.startsWith('00:00:00') ? day : `${day} ${time.slice(0, 5)}`;
}

// A tab as CSV, its values as the spreadsheet shows them. A date in a format SheetJS can't show,
// as it can't German ones like dd.mm.yyyy, is written as 2026-03-01 rather than as its number.
function sheetCsv(sheet: XLSX.WorkSheet): string {
	for (const [address, cell] of Object.entries(sheet)) {
		if (!address.startsWith('!') && cell.t === 'd' && cell.w === undefined && cell.v instanceof Date) {
			cell.w = dateText(cell.v);
		}
	}
	return XLSX.utils.sheet_to_csv(sheet, {blankrows: false, strip: true}).trim();
}

// Every tab with anything in it, as CSV, under its name.
function spreadsheetText(file: AttachmentFile): Result<string, ApiError> {
	return Result.wrap(() => {
		const book = XLSX.read(file.bytes, {type: 'array', cellDates: true});
		return book.SheetNames.flatMap((name) => {
			const sheet = book.Sheets[name];
			const csv = sheet ? sheetCsv(sheet) : '';
			return csv === '' ? [] : [`Tab: ${name}\n${csv}`];
		}).join('\n\n');
	}).mapErr((cause) => unreadable(file, cause));
}

async function pdfText(file: AttachmentFile): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const pdf = $((await Result.wrapAsync(() => getDocumentProxy(new Uint8Array(file.bytes)))).mapErr((cause) => unreadable(file, cause)));
		const {text} = $((await Result.wrapAsync(() => extractText(pdf, {mergePages: false}))).mapErr((cause) => unreadable(file, cause)));
		const pages = text.map((page) => page.trim());
		if (pages.every((page) => page === '')) {
			return $(Err(ApiErr.validationError(`“${file.name}” has no text in it, as a scan hasn’t: only its pictures`)));
		}
		return pages.join('\n\n');
	});
}

async function wordText(file: AttachmentFile): Promise<Result<string, ApiError>> {
	const extracted = await Result.wrapAsync(() => mammoth.extractRawText({buffer: Buffer.from(file.bytes)}));
	return extracted.map(({value}) => value.replace(/\n{3,}/g, '\n\n').trim()).mapErr((cause) => unreadable(file, cause));
}

// A forwarded email: who it was from and to, when, its subject and its text.
async function emailText(file: AttachmentFile): Promise<Result<string, ApiError>> {
	const parsed = await Result.wrapAsync(() => simpleParser(Buffer.from(file.bytes)));
	return parsed
		.map((mail) => {
			const headers = [
				['From', mail.from?.text],
				[
					'To',
					[mail.to ?? []]
						.flat()
						.map((to) => to.text)
						.join(', '),
				],
				['Date', mail.date?.toISOString()],
				['Subject', mail.subject],
			].flatMap(([name, value]) => (value ? [`${name}: ${value}`] : []));
			const body = (mail.text ?? (mail.html ? htmlToText(mail.html) : '')).trim();
			const attachments = mail.attachments.length > 0 ? `\n\nAttachments: ${mail.attachments.map((attachment) => attachment.filename ?? 'Untitled').join(', ')}` : '';
			return `${headers.join('\n')}\n\n${body}${attachments}`;
		})
		.mapErr((cause) => unreadable(file, cause));
}

function charsetOf(type: string): string | null {
	return /charset="?([^";\s]+)"?/i.exec(type)?.[1] ?? null;
}

function textOf(file: AttachmentFile, kind: Kind): Promise<Result<string, ApiError>> {
	if (kind === 'spreadsheet') {
		return Promise.resolve(spreadsheetText(file));
	}
	if (kind === 'pdf') {
		return pdfText(file);
	}
	if (kind === 'word') {
		return wordText(file);
	}
	if (kind === 'email') {
		return emailText(file);
	}
	const text = decodeText(file.bytes, charsetOf(file.type));
	if (kind === 'html') {
		return Promise.resolve(Ok(htmlToText(text)));
	}
	return Promise.resolve(Ok(text.replace(/\r\n?/g, '\n')));
}

function lengthText(length: number): string {
	if (length > MAX_CHARACTERS) {
		return `The first ${MAX_CHARACTERS} of ${length} characters`;
	}
	return `${length} characters`;
}

/** What an attachment is read as, by its name and type, before its content is fetched; one too large or that isn't text is turned down. */
export function readableKind(attachment: AttachmentInfo): Result<Kind, ApiError> {
	const kind = kindOf(attachment);
	if (kind === null) {
		return Err(ApiErr.validationError(`“${attachment.name}” (${attachment.type || 'unknown type'}) can’t be read as text: only spreadsheets, PDFs, Word documents, emails and text can`));
	}
	if (attachment.size > MAX_BYTES) {
		return Err(ApiErr.validationError(`“${attachment.name}” is too large to read, at ${sizeText(attachment.size)}: at most ${sizeText(MAX_BYTES)}`));
	}
	return Ok(kind);
}

/** An attachment read as text, as the `attachments` collection answers it. */
export function attachmentRecord(email: string, number: number, file: AttachmentFile): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const kind = $(readableKind({...file, size: Math.max(file.size, file.bytes.length)}));
		const text = $(await textOf(file, kind));
		const values = {
			email,
			attachment: String(number),
			name: file.name,
			type: file.type,
			size: sizeText(file.size || file.bytes.length),
			length: lengthText(text.length),
			content: text.slice(0, MAX_CHARACTERS),
		};
		return {id: `${email}/${number}`, values, updatedAt: new Date().toISOString()};
	});
}
