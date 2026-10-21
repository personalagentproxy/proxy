import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('@proxy/db/connection', () => ({updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function emails(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'emails');
	if (!found) {
		throw new Error('No emails collection');
	}
	return found;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const target = {
	connection: {id: 'google-1', integrationId: 'google', account: 'alex@example.com', createdAt: new Date(), tools: null, name: null, defaults: [], credential: `enc:${JSON.stringify(CREDENTIAL)}`},
	collection: emails(),
};

const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});

const base64url = (text: string): string => Buffer.from(text).toString('base64url');

type Header = {name: string; value: string};
type Part = {mimeType: string; filename: string; headers?: Header[]; body: {size: number; data?: string; attachmentId?: string}; parts?: Part[]};
type Message = {id: string; threadId: string; labelIds: string[]; internalDate: string; payload: Part};

function message(id: string, labelIds: string[], headers: Record<string, string>, parts: Part[] = []): Message {
	return {
		id,
		threadId: `thread-${id}`,
		labelIds,
		internalDate: String(Date.parse('2026-10-01T09:00:00Z')),
		payload: {mimeType: 'multipart/alternative', filename: '', headers: Object.entries(headers).map(([name, value]) => ({name, value})), body: {size: 0}, parts},
	};
}

const text = (body: string): Part => ({
	mimeType: 'text/plain',
	filename: '',
	headers: [{name: 'Content-Type', value: 'text/plain; charset="UTF-8"'}],
	body: {size: body.length, data: base64url(body)},
});
const html = (body: string): Part => ({mimeType: 'text/html', filename: '', headers: [{name: 'Content-Type', value: 'text/html; charset="UTF-8"'}], body: {size: body.length, data: base64url(body)}});

// A mailbox as Gmail answers it: an unread email from Sam in the inbox, one sent, and a draft.
function mailbox(): Record<string, Message> {
	return {
		m1: message(
			'm1',
			['UNREAD', 'IMPORTANT', 'INBOX'],
			{Subject: 'Q3 planning', From: '"Sam Lee" <sam@example.com>', To: 'Alex Kim <alex@example.com>', Cc: 'Jo Park <jo@example.com>', Date: 'Thu, 1 Oct 2026 09:00:00 +0000'},
			[text('Agenda attached.\n'), html('<p>Agenda attached.</p>')],
		),
		m2: message('m2', ['SENT'], {Subject: 'Re: dinner', From: 'Alex Kim <alex@example.com>', To: 'Robin <robin@example.com>'}, [html('<p>See you <b>Friday</b>&nbsp;at 8.</p>')]),
		m3: message(
			'm3',
			['DRAFT'],
			{Subject: 'Offer', From: 'alex@example.com', To: 'Robin <robin@example.com>', Cc: 'sam@example.com', 'In-Reply-To': '<abc@example.com>', References: '<abc@example.com>'},
			[text('Draft text')],
		),
	};
}

type Call = {method: string; url: URL; body: Record<string, unknown> | null};

const gmail = {
	calls: [] as Call[],
	messages: mailbox(),
	drafts: {r1: 'm3'} as Record<string, string>,
	answer: (_call: Call): Response | null => null,
};

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'Requested entity was not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

function draftAnswer(draftId: string): Response {
	const messageId = gmail.drafts[draftId];
	const found = messageId ? gmail.messages[messageId] : undefined;
	return found ? Response.json({id: draftId, message: found}) : notFound();
}

function answer(call: Call): Response {
	const custom = gmail.answer(call);
	if (custom) {
		return custom;
	}
	const path = call.url.pathname.replace('/gmail/v1/users/me', '');
	if (path === '/messages' && call.method === 'GET') {
		return Response.json({messages: Object.keys(gmail.messages).map((id) => ({id, threadId: `thread-${id}`})), nextPageToken: 'page-2', resultSizeEstimate: 3});
	}
	if (path === '/drafts' && call.method === 'GET') {
		return Response.json({drafts: Object.entries(gmail.drafts).map(([id, messageId]) => ({id, message: {id: messageId, threadId: `thread-${messageId}`}}))});
	}
	if (path === '/drafts' && call.method === 'POST') {
		gmail.drafts.r2 = 'm4';
		gmail.messages.m4 = message('m4', ['DRAFT'], {Subject: 'New', From: 'alex@example.com', To: 'robin@example.com'}, [text('Hello')]);
		return Response.json({id: 'r2', message: {id: 'm4', threadId: 'thread-m4', labelIds: ['DRAFT']}});
	}
	if (path === '/drafts/send') {
		return Response.json({id: 'm9', threadId: 'thread-m9', labelIds: ['SENT']});
	}
	if (path === '/messages/send') {
		return Response.json({id: 'm8', threadId: 'thread-m8', labelIds: ['SENT']});
	}
	const draft = /^\/drafts\/([^/]+)$/.exec(path)?.[1];
	if (draft && call.method === 'DELETE') {
		return gmail.drafts[draft] ? new Response(null, {status: 204}) : notFound();
	}
	if (draft) {
		return draftAnswer(draft);
	}
	const [, id, verb] = /^\/messages\/([^/]+)(?:\/(modify|trash))?$/.exec(path) ?? [];
	const found = id ? gmail.messages[id] : undefined;
	if (!found) {
		return notFound();
	}
	if (verb === 'modify') {
		const {addLabelIds = [], removeLabelIds = []} = call.body as {addLabelIds?: string[]; removeLabelIds?: string[]};
		found.labelIds = [...found.labelIds.filter((label) => !removeLabelIds.includes(label)), ...addLabelIds];
	}
	if (verb === 'trash') {
		found.labelIds = [...found.labelIds, 'TRASH'];
	}
	return Response.json(found);
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
	const call = {method: init?.method ?? 'GET', url, body};
	gmail.calls.push(call);
	return answer(call);
}) as typeof fetch);

function calls(method: string, path: string): Call[] {
	return gmail.calls.filter((call) => call.method === method && call.url.pathname === `/gmail/v1/users/me${path}`);
}

// The RFC 2822 text a raw message holds, its headers unfolded.
function rawText(body: Record<string, unknown> | null | undefined): string {
	const raw = (body?.raw as string | undefined) ?? '';
	return Buffer.from(raw, 'base64url')
		.toString('utf8')
		.replace(/\r\n[ \t]+/g, ' ');
}

beforeEach(() => {
	gmail.calls = [];
	gmail.messages = mailbox();
	gmail.drafts = {r1: 'm3'};
	gmail.answer = () => null;
});

async function connector() {
	const {googleConnector} = await import('./google-connector');
	return googleConnector;
}

describe('findGmailEmails', () => {
	test("searches all mail in Gmail's syntax and reads only as many as asked for, by their message ids", async () => {
		const {findGmailEmails} = await import('./google-emails');
		const [found = []] = (await findGmailEmails(target, [{from: 'Sam Lee', words: [['planning']], since: '2026-09-01'}], 2)).unwrap();

		const [list] = calls('GET', '/messages');
		expect(Object.fromEntries(list?.url.searchParams ?? [])).toEqual({maxResults: '2', q: 'from:"Sam Lee" planning after:2026/09/01'});
		// With who was copied, which the widgets find people in, and Gmail's page for each.
		expect(found.map((record) => [record.id, record.values.subject, record.values.cc, record.url])).toEqual([
			['m1', 'Q3 planning', 'Jo Park <jo@example.com>', 'https://mail.google.com/mail/?authuser=alex%40example.com#all/m1'],
			['m2', 'Re: dinner', '', 'https://mail.google.com/mail/?authuser=alex%40example.com#all/m2'],
		]);
		expect(calls('GET', '/messages/m3')).toHaveLength(0);
	});
});

describe('list', () => {
	test('a folder is its label, the search Gmail’s own, from the page token given, each message read for its headers', async () => {
		const page = (await (await connector()).list(target, query({filter: 'Inbox', search: 'from:sam', page: 'page-1'}))).unwrap();

		const [list] = calls('GET', '/messages');
		expect(Object.fromEntries(list?.url.searchParams ?? [])).toEqual({maxResults: '50', labelIds: 'INBOX', q: 'from:sam', pageToken: 'page-1'});
		expect(calls('GET', '/messages/m1')[0]?.url.searchParams.getAll('metadataHeaders')).toEqual(['Subject', 'From', 'To', 'Cc']);
		expect(calls('GET', '/messages/m1')[0]?.url.searchParams.get('format')).toBe('metadata');
		expect(page.nextPage).toBe('page-2');
		expect(page.records[0]).toEqual({
			id: 'm1',
			values: {folder: 'Inbox', from: 'Sam Lee <sam@example.com>', to: 'Alex Kim <alex@example.com>', subject: 'Q3 planning', date: '2026-10-01T09:00:00.000Z', status: 'Unread'},
			updatedAt: '2026-10-01T09:00:00.000Z',
			// In Gmail, in the connection's account.
			url: 'https://mail.google.com/mail/?authuser=alex%40example.com#all/m1',
		});
	});

	test('without a folder, every email, a draft by its draft id with its addresses bare', async () => {
		const page = (await (await connector()).list(target, query())).unwrap();

		expect(calls('GET', '/messages')[0]?.url.searchParams.has('labelIds')).toBe(false);
		expect(page.records.map((record) => [record.id, record.values.folder])).toEqual([
			['m1', 'Inbox'],
			['m2', 'Sent'],
			['draft-r1', 'Draft'],
		]);
		expect(page.records[2]?.values.to).toBe('robin@example.com');
		expect(page.records[1]?.values.status).toBe('');
	});

	test('the archive is a search, Trash and Spam asked for by their labels', async () => {
		const c = await connector();
		await c.list(target, query({filter: 'Archive', search: 'invoice'}));
		await c.list(target, query({filter: 'Trash'}));

		const [archive, trash] = calls('GET', '/messages');
		expect(archive?.url.searchParams.get('q')).toBe('-in:inbox -in:sent -in:drafts -in:trash -in:spam (invoice)');
		expect(archive?.url.searchParams.has('labelIds')).toBe(false);
		expect(trash?.url.searchParams.get('labelIds')).toBe('TRASH');
		expect(trash?.url.searchParams.get('includeSpamTrash')).toBe('true');
	});

	test('drafts are listed as drafts, searched and paged by Gmail', async () => {
		gmail.answer = (call) => (call.url.pathname.endsWith('/drafts') ? Response.json({drafts: [{id: 'r1', message: {id: 'm3', threadId: 'thread-m3'}}], nextPageToken: 'drafts-2'}) : null);
		const page = (await (await connector()).list(target, query({filter: 'Draft', search: 'offer'}))).unwrap();

		expect(Object.fromEntries(calls('GET', '/drafts')[0]?.url.searchParams ?? [])).toEqual({maxResults: '50', q: 'offer'});
		expect(calls('GET', '/messages')).toEqual([]);
		expect(page.records.map((record) => record.id)).toEqual(['draft-r1']);
		expect(page.nextPage).toBe('drafts-2');
	});

	test('a message Gmail turns down as busy is asked for again, so the page still lists it', async () => {
		let busy = 1;
		gmail.answer = (call) => {
			if (call.url.pathname.endsWith('/messages/m2') && busy > 0) {
				busy -= 1;
				return Response.json({error: {code: 429, message: 'Too many concurrent requests for user.', errors: [{reason: 'rateLimitExceeded'}]}}, {status: 429});
			}
			return null;
		};
		const page = (await (await connector()).list(target, query())).unwrap();

		expect(page.records.map((record) => record.id)).toEqual(['m1', 'm2', 'draft-r1']);
		expect(calls('GET', '/messages/m2')).toHaveLength(2);
	});

	test('a draft moved to Trash is not looked for among the drafts', async () => {
		gmail.messages.m3 = {...message('m3', ['DRAFT', 'TRASH'], {Subject: 'Offer'}), threadId: 'thread-m3'};
		const page = (await (await connector()).list(target, query({filter: 'Trash'}))).unwrap();

		expect(page.records.find((record) => record.id === 'm3')?.values.folder).toBe('Trash');
		expect(calls('GET', '/drafts')).toEqual([]);
	});

	test('the last page has no next one, and an email gone before it was read is left out', async () => {
		gmail.answer = (call) => (call.url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'm1'}, {id: 'gone'}]}) : null);
		const page = (await (await connector()).list(target, query({page: 'page-2'}))).unwrap();

		expect(page.records.map((record) => record.id)).toEqual(['m1']);
		expect(page.nextPage).toBeNull();
	});
});

describe('get', () => {
	test('an email opens with its text part', async () => {
		const record = (await (await connector()).get(target, 'm1')).unwrap();

		expect(calls('GET', '/messages/m1')[0]?.url.searchParams.get('format')).toBe('full');
		expect(record.values.body).toBe('Agenda attached.');
		expect(record.values.subject).toBe('Q3 planning');
	});

	test('an email with only HTML opens as its text', async () => {
		const record = (await (await connector()).get(target, 'm2')).unwrap();

		expect(record.values.body).toBe('See you Friday at 8.');
		expect(record.values.folder).toBe('Sent');
	});

	test('a draft opens by its draft id, and by its message id is given its draft id', async () => {
		const c = await connector();
		const byDraft = (await c.get(target, 'draft-r1')).unwrap();
		const byMessage = (await c.get(target, 'm3')).unwrap();

		expect(byDraft.id).toBe('draft-r1');
		expect(byDraft.values).toMatchObject({folder: 'Draft', to: 'robin@example.com', body: 'Draft text'});
		expect(byMessage.id).toBe('draft-r1');
		// A draft opens in Gmail to be written, by its message id.
		expect(byDraft.url).toBe('https://mail.google.com/mail/?authuser=alex%40example.com#drafts?compose=m3');
	});

	test('an email Gmail doesn’t have is not found, and an id that isn’t Gmail’s never reaches it', async () => {
		const c = await connector();

		expect((await c.get(target, 'missing')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record', id: 'missing'});
		expect((await c.get(target, '../labels')).unwrapErr().kind).toBe('not_found');
		expect(calls('GET', '/messages/../labels')).toEqual([]);
		expect(gmail.calls.map((call) => call.url.pathname)).toEqual(['/gmail/v1/users/me/messages/missing']);
	});
});

describe('drafts', () => {
	test('a new draft is written from the connection’s address and read back by its draft id', async () => {
		const record = (await (await connector()).create(target, {to: 'robin@example.com', subject: 'New', body: 'Hello'}, null)).unwrap();

		const raw = rawText(calls('POST', '/drafts')[0]?.body?.message as Record<string, unknown>);
		expect(raw).toContain('From: alex@example.com');
		expect(raw).toContain('To: robin@example.com');
		expect(raw).toContain('Subject: New');
		expect(raw).toContain('Hello');
		expect(record).toMatchObject({id: 'draft-r2', values: {folder: 'Draft', subject: 'New'}});
	});

	test('an edit writes the fields given over the rest, keeping the draft’s Cc and thread', async () => {
		const record = (await (await connector()).update(target, 'draft-r1', {subject: 'Offer, revised'})).unwrap();

		const [put] = calls('PUT', '/drafts/r1');
		const sent = put?.body as {id: string; message: {threadId: string}};
		expect(sent.id).toBe('r1');
		expect(sent.message.threadId).toBe('thread-m3');
		const raw = rawText(sent.message);
		expect(raw).toContain('Subject: Offer, revised');
		expect(raw).toContain('To: Robin <robin@example.com>');
		expect(raw).toContain('Cc: sam@example.com');
		expect(raw).toContain('In-Reply-To: <abc@example.com>');
		expect(raw).toContain('Draft text');
		expect(record.id).toBe('draft-r1');
	});

	test('an edit with every field, as the agent side sends one, keeps the names and the HTML of what is unchanged', async () => {
		const m3 = gmail.messages.m3;
		m3?.payload.parts?.push(html('<p>Draft <b>text</b></p>'));
		await (await connector()).update(target, 'draft-r1', {to: 'robin@example.com', subject: 'Offer, revised', body: 'Draft text'});

		const raw = rawText((calls('PUT', '/drafts/r1')[0]?.body as {message: Record<string, unknown>}).message);
		expect(raw).toContain('To: Robin <robin@example.com>');
		expect(raw).toContain('Content-Type: text/html');
		expect(raw).toContain('<p>Draft <b>text</b></p>');
	});

	test('an edit to the text writes it as text alone, and to the recipients as written', async () => {
		const m3 = gmail.messages.m3;
		m3?.payload.parts?.push(html('<p>Draft <b>text</b></p>'));
		await (await connector()).update(target, 'draft-r1', {to: 'sam@example.com', subject: 'Offer', body: 'New text'});

		const raw = rawText((calls('PUT', '/drafts/r1')[0]?.body as {message: Record<string, unknown>}).message);
		expect(raw).toContain('To: sam@example.com');
		expect(raw).toContain('New text');
		expect(raw).not.toContain('text/html');
	});

	test('a draft with attachments isn’t edited, and an email that isn’t a draft never is', async () => {
		const c = await connector();
		const m3 = gmail.messages.m3;
		m3?.payload.parts?.push({mimeType: 'application/pdf', filename: 'offer.pdf', body: {size: 10, attachmentId: 'a1'}});

		expect((await c.update(target, 'draft-r1', {subject: 'x'})).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('attachments')});
		expect((await c.update(target, 'm1', {subject: 'x'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await c.remove(target, 'm1')).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(calls('PUT', '/drafts/r1')).toEqual([]);
	});

	test('deleting a draft deletes it at Gmail, and a missing one is not found', async () => {
		const c = await connector();

		expect((await c.remove(target, 'draft-r1')).isOk()).toBe(true);
		expect(calls('DELETE', '/drafts/r1')).toHaveLength(1);
		expect((await c.remove(target, 'draft-r9')).unwrapErr().kind).toBe('not_found');
	});
});

describe('commands', () => {
	test.each([
		['markRead', {addLabelIds: [], removeLabelIds: ['UNREAD']}],
		['markUnread', {addLabelIds: ['UNREAD'], removeLabelIds: []}],
		['flag', {addLabelIds: ['STARRED'], removeLabelIds: []}],
		['unflag', {addLabelIds: [], removeLabelIds: ['STARRED']}],
		['archive', {addLabelIds: [], removeLabelIds: ['INBOX']}],
	])('%s changes the labels and reads the email back', async (command, change) => {
		const run = (await connector()).commands?.[command];
		const record = (await run?.(target, 'm1'))?.unwrap();

		expect(calls('POST', '/messages/m1/modify')[0]?.body).toEqual(change);
		expect(record?.id).toBe('m1');
	});

	test('starring shows in the status, archiving moves the email to the archive', async () => {
		const c = await connector();

		expect((await c.commands?.flag?.(target, 'm1'))?.unwrap()?.values.status).toBe('Unread, Starred');
		expect((await c.commands?.archive?.(target, 'm1'))?.unwrap()?.values).toMatchObject({folder: 'Archive', status: ''});
	});

	test('moving to Trash is Gmail’s trash, never a delete', async () => {
		const record = (await (await connector()).commands?.trash?.(target, 'm1'))?.unwrap();

		expect(calls('POST', '/messages/m1/trash')).toHaveLength(1);
		expect(gmail.calls.some((call) => call.method === 'DELETE')).toBe(false);
		expect(record?.values.folder).toBe('Trash');
	});

	test('a command on a missing email is not found', async () => {
		expect((await (await connector()).commands?.markRead?.(target, 'gone'))?.unwrapErr().kind).toBe('not_found');
	});

	test('sending a draft sends it as saved', async () => {
		const sent = await (await connector()).commands?.send?.(target, 'draft-r1');

		expect(sent?.unwrap()).toBeNull();
		expect(calls('POST', '/drafts/send')[0]?.body).toEqual({id: 'r1'});
	});

	test('a draft named by its message id is sent by its draft id', async () => {
		const sent = await (await connector()).commands?.send?.(target, 'm3');

		expect(sent?.unwrap()).toBeNull();
		expect(calls('POST', '/drafts/send')[0]?.body).toEqual({id: 'r1'});
		expect(((await (await connector()).commands?.send?.(target, 'm1'))?.unwrapErr() as {message?: string}).message).toBe('Only drafts can be sent');
	});

	test('a draft without a recipient isn’t sent', async () => {
		gmail.messages.m3 = message('m3', ['DRAFT'], {Subject: 'Offer', From: 'alex@example.com'}, [text('Draft text')]);
		const sent = await (await connector()).commands?.send?.(target, 'draft-r1');

		expect(sent?.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'The email has no recipient'});
		expect(calls('POST', '/drafts/send')).toEqual([]);
	});

	test('a new email goes out from the connection’s address', async () => {
		const c = await connector();
		const sent = await c.newCommands?.sendNew?.(target, {to: 'robin@example.com, sam@example.com', subject: 'Hello there', body: 'Line one'});

		expect(sent?.unwrap()).toBeNull();
		const raw = rawText(calls('POST', '/messages/send')[0]?.body);
		expect(raw).toContain('From: alex@example.com');
		expect(raw).toContain('To: robin@example.com, sam@example.com');
		expect(raw).toContain('Subject: Hello there');
		expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@proxy>/);
		expect(raw).toContain('Line one');
		expect((await c.newCommands?.sendNew?.(target, {to: ' ', subject: 'x', body: 'y'}))?.unwrapErr().kind).toBe('validation_error');
	});
});

describe('replyToGmail', () => {
	async function replyToGmail() {
		return (await import('./google-emails')).replyToGmail;
	}

	function withHeaders(id: string, headers: Record<string, string>) {
		const found = gmail.messages[id];
		found?.payload.headers?.push(...Object.entries(headers).map(([name, value]) => ({name, value})));
	}

	test('sends a reply to the sender from the connection’s address, in the email’s thread', async () => {
		withHeaders('m1', {'Message-ID': '<q3@example.com>', References: '<agenda@example.com>'});
		const headers = (await (await replyToGmail())(target, 'm1', {body: 'Works for me.', send: true})).unwrap();

		expect(headers).toEqual({to: '"Sam Lee" <sam@example.com>', subject: 'Re: Q3 planning', inReplyTo: '<q3@example.com>', references: '<agenda@example.com> <q3@example.com>'});
		const [sent] = calls('POST', '/messages/send');
		expect(sent?.body?.threadId).toBe('thread-m1');
		const raw = rawText(sent?.body);
		expect(raw).toContain('From: alex@example.com');
		expect(raw).toContain('To: Sam Lee <sam@example.com>');
		expect(raw).toContain('Subject: Re: Q3 planning');
		expect(raw).toContain('In-Reply-To: <q3@example.com>');
		expect(raw).toContain('References: <agenda@example.com> <q3@example.com>');
		expect(raw).toContain('Works for me.');
		expect(raw).not.toContain('Cc:');
		expect(calls('POST', '/drafts')).toEqual([]);
	});

	test('saves a reply as a draft in the thread, to where the email asks replies to go', async () => {
		withHeaders('m1', {'Reply-To': 'planning@example.com', 'Message-ID': '<q3@example.com>'});
		(await (await replyToGmail())(target, 'm1', {body: 'Draft reply', send: false})).unwrap();

		const message = calls('POST', '/drafts')[0]?.body?.message as Record<string, unknown>;
		expect(message.threadId).toBe('thread-m1');
		expect(rawText(message)).toContain('To: planning@example.com');
		expect(calls('POST', '/messages/send')).toEqual([]);
	});

	test('a reply to an email sent goes to whom it went, under its subject as it is', async () => {
		const headers = (await (await replyToGmail())(target, 'm2', {body: 'Running late', send: true})).unwrap();

		expect(headers).toMatchObject({to: 'Robin <robin@example.com>', subject: 'Re: dinner'});
	});

	test('replies to no draft, and to no email Gmail doesn’t have', async () => {
		const reply = await replyToGmail();

		expect((await reply(target, 'draft-r1', {body: 'x', send: true})).unwrapErr().kind).toBe('validation_error');
		expect((await reply(target, 'gone', {body: 'x', send: true})).unwrapErr().kind).toBe('not_found');
		expect(calls('POST', '/messages/send')).toEqual([]);
	});
});
