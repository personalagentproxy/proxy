import {describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {MessagePart} from './gmail-api';

// The Gmail calls go through the Google client, which reads the environment and the database on
// import; only the reading of Gmail's answers is tested here.
mock.module('@proxy/db/connection', () => ({updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

const {attachmentsOf, folderOf, folderQuery, messageBody} = await import('./gmail-api');

const base64url = (text: string, encoding: BufferEncoding = 'utf8'): string => Buffer.from(text, encoding).toString('base64url');

function textPart(mimeType: string, text: string, contentType = `${mimeType}; charset="UTF-8"`): MessagePart {
	return {mimeType, filename: '', headers: [{name: 'Content-Type', value: contentType}], body: {size: text.length, data: base64url(text)}};
}

function attachment(filename: string): MessagePart {
	return {mimeType: 'application/pdf', filename, headers: [{name: 'Content-Disposition', value: `attachment; filename="${filename}"`}], body: {size: 1200, attachmentId: 'att-1'}};
}

describe('folderOf', () => {
	test('a message is in the folder of its label, the inbox before sent, Trash before a draft', () => {
		expect(folderOf(['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'INBOX'])).toBe('Inbox');
		expect(folderOf(['SENT'])).toBe('Sent');
		expect(folderOf(['SENT', 'INBOX', 'UNREAD'])).toBe('Inbox');
		expect(folderOf(['DRAFT'])).toBe('Draft');
		expect(folderOf(['DRAFT', 'TRASH'])).toBe('Trash');
		expect(folderOf(['SPAM', 'UNREAD'])).toBe('Spam');
	});

	test('one in none of the folders is archived', () => {
		expect(folderOf(['IMPORTANT', 'Label_12'])).toBe('Archive');
		expect(folderOf([])).toBe('Archive');
	});
});

describe('folderQuery', () => {
	test('a folder is its label, with the search as it is', () => {
		expect(folderQuery('Inbox', 'from:sam')).toEqual({labelIds: ['INBOX'], q: 'from:sam', includeSpamTrash: false});
		expect(folderQuery('Draft', null)).toEqual({labelIds: ['DRAFT'], q: null, includeSpamTrash: false});
		expect(folderQuery('Sent', null)).toEqual({labelIds: ['SENT'], q: null, includeSpamTrash: false});
	});

	test('Trash and Spam are asked for, since Gmail leaves them out otherwise', () => {
		expect(folderQuery('Trash', null)).toEqual({labelIds: ['TRASH'], q: null, includeSpamTrash: true});
		expect(folderQuery('Spam', 'invoice')).toEqual({labelIds: ['SPAM'], q: 'invoice', includeSpamTrash: true});
	});

	test('the archive is a search for what is in no folder, the search in parentheses beside it', () => {
		expect(folderQuery('Archive', null)).toEqual({labelIds: [], q: '-in:inbox -in:sent -in:drafts -in:trash -in:spam', includeSpamTrash: false});
		expect(folderQuery('Archive', 'from:sam OR from:alex').q).toBe('-in:inbox -in:sent -in:drafts -in:trash -in:spam (from:sam OR from:alex)');
	});

	test('without a folder, all mail but Spam and Trash', () => {
		expect(folderQuery(null, null)).toEqual({labelIds: [], q: null, includeSpamTrash: false});
	});
});

describe('messageBody', () => {
	test('the plain text part of an alternative, before the HTML one', () => {
		const payload: MessagePart = {
			mimeType: 'multipart/alternative',
			filename: '',
			parts: [textPart('text/plain', 'Hi Alex,\n\nSee you Friday.\n'), textPart('text/html', '<p>Hi Alex,</p><p>See you <b>Friday</b>.</p>')],
		};

		expect(messageBody(payload)).toBe('Hi Alex,\n\nSee you Friday.');
	});

	test('a message with only HTML reads as its text, with links and blocks kept', () => {
		const html =
			'<html><head><style>p {color: red}</style></head><body><p>Your order&nbsp;has shipped &amp; is on its way.</p><div>Track it <a href="https://example.com/track/1">here</a>.</div><ul><li>One</li><li>Two</li></ul></body></html>';

		expect(messageBody(textPart('text/html', html))).toBe('Your order has shipped & is on its way.\nTrack it here (https://example.com/track/1).\n\n- One\n- Two');
	});

	test('nested parts are walked, a text part in the charset it names, and the attachments found apart from it', () => {
		const latin = {mimeType: 'text/plain', filename: '', headers: [{name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1'}], body: {size: 12, data: base64url('Grüße, Sam', 'latin1')}};
		const payload: MessagePart = {
			mimeType: 'multipart/mixed',
			filename: '',
			parts: [{mimeType: 'multipart/alternative', filename: '', parts: [latin, textPart('text/html', '<p>Grüße</p>')]}, attachment('invoice.pdf'), attachment('receipt.pdf')],
		};

		expect(messageBody(payload)).toBe('Grüße, Sam');
		expect(attachmentsOf(payload)).toEqual([
			{name: 'invoice.pdf', type: 'application/pdf', size: 1200, data: null, attachmentId: 'att-1'},
			{name: 'receipt.pdf', type: 'application/pdf', size: 1200, data: null, attachmentId: 'att-1'},
		]);
	});

	test('a part naming another charset whose content Gmail hands over as UTF-8 is read as UTF-8', () => {
		const part = {
			mimeType: 'text/plain',
			filename: '',
			headers: [{name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"'}],
			body: {size: 30, data: base64url('mit der Zusammenfassung bin ich selbstverständlich einverstanden')},
		};

		expect(messageBody(part)).toBe('mit der Zusammenfassung bin ich selbstverständlich einverstanden');
	});

	test('a part in a charset TextDecoder doesn’t know, or naming none, that isn’t UTF-8 is read as Windows-1252', () => {
		const unknown = {mimeType: 'text/plain', filename: '', headers: [{name: 'Content-Type', value: 'text/plain; charset=x-unknown'}], body: {size: 6, data: base64url('Grüße', 'latin1')}};
		const unnamed = {mimeType: 'text/plain', filename: '', headers: [{name: 'Content-Type', value: 'text/plain'}], body: {size: 6, data: base64url('Grüße', 'latin1')}};

		expect(messageBody(unknown)).toBe('Grüße');
		expect(messageBody(unnamed)).toBe('Grüße');
	});

	test('a text attachment is not the body', () => {
		const payload: MessagePart = {mimeType: 'multipart/mixed', filename: '', parts: [{...textPart('text/plain', 'notes'), filename: 'notes.txt'}, textPart('text/html', '<p>The body</p>')]};

		expect(messageBody(payload)).toBe('The body');
		expect(attachmentsOf(payload).map(({name, data}) => [name, data])).toEqual([['notes.txt', base64url('notes')]]);
	});

	test('a message without parts is empty', () => {
		expect(messageBody(undefined)).toBe('');
	});

	test("a part's line endings read as new lines in text, and as spaces in HTML", () => {
		expect(messageBody(textPart('text/plain', 'Hi Alex,\r\n\r\nSee you Friday.\r\n'))).toBe('Hi Alex,\n\nSee you Friday.');
		expect(messageBody(textPart('text/html', '<p>Hi\r\nAlex,</p>\r\n<p>See you\nFriday.</p>'))).toBe('Hi Alex,\nSee you Friday.');
	});
});
