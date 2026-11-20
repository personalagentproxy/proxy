import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {FileUndo} from '@proxy/db/file-undo';

import type {DocumentRequest} from '../connections/google/docs-api';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// The history every edit goes through (google-history.ts), kept in memory: whether the task has
// its copy already, the versions kept and the changes logged, to look at.
type Logged = {kind: string; fileId: string; name: string; beforeVersion?: string | null; beforeRevision?: string | null; afterRevision?: string | null; undo?: FileUndo | null};
const history = {copied: true, kept: [] as {sourceRevision: string | null}[], logged: [] as Logged[]};
mock.module('@proxy/db/files', () => ({
	hasTaskCopied: mock(async () => Ok(history.copied)),
	getLatestFileVersion: mock(async () => Ok(null)),
	recordFileVersion: mock(async ({content}: {content: {sourceRevision: string | null}}) => {
		history.kept.push(content);
		return Ok({id: `version-${history.kept.length}`});
	}),
	logFileChange: mock(async (_change: object, entry: Logged) => {
		history.logged.push(entry);
		return Ok({change: {id: `change-${history.logged.length}`, ...entry}, version: null});
	}),
	createFileBlob: mock(async (data: {orgId: string; backendId: string; key: string}) => Ok({id: 'blob-1', ...data, size: 0, sha256: null})),
	completeFileBlob: mock(async (id: string, data: {size: number; sha256: string}) => Ok({id, ...data})),
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// The copies a task's first change keeps go into a directory of their own.
const blobs = mkdtempSync(join(tmpdir(), 'proxy-docs-test-'));
mock.module('../utils/env', () => ({
	env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1', DRIVE_COPY_MAX_MB: 25, FILES_STORE: {kind: 'disk', dir: blobs}},
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

// What a refusal says, its kind first.
function refusal<T>(result: Result<T, ApiError>): string {
	if (result.isOk()) {
		throw new Error('expected a refusal');
	}
	return 'message' in result.error && result.error.message ? `${result.error.kind}: ${result.error.message}` : result.error.kind;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const connection = {
	id: 'google-1',
	integrationId: 'google',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credentialRejectedAt: null,
	credential: `enc:${JSON.stringify(CREDENTIAL)}`,
};

const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};

function run(params: Record<string, unknown>) {
	return {caller: {agent, via: 'mcp' as const, taskId: 'task-1'}, connection, params};
}

// ---- A fake document -------------------------------------------------------------------------

// What a document is made of here: paragraphs of text runs, an inline image among them as IMAGE,
// a table of cells, each a paragraph, and a table of contents, which Docs writes itself.
const IMAGE = Symbol('image');
type Block = {paragraph: (string | typeof IMAGE)[]} | {table: string[][]} | {contents: string[]};

type Run = {startIndex: number; endIndex: number; textRun?: {content: string; textStyle: Record<string, never>}; inlineObjectElement?: {inlineObjectId: string}};
type Element = {
	startIndex?: number;
	endIndex: number;
	sectionBreak?: Record<string, never>;
	paragraph?: {elements: Run[]; paragraphStyle: {namedStyleType: string}};
	table?: {rows: number; columns: number; tableRows: {tableCells: {content: Element[]}[]}[]};
	tableOfContents?: {content: Element[]};
};

// The body as Docs answers it, each part at its place, counted in UTF-16 code units from the
// section break at 0, and the same body as one string, one character a place, ￼ where none is text.
function documentOf(blocks: Block[]): {content: Element[]; text: string} {
	let at = 1;
	let text = '￼';
	const mark = () => {
		at += 1;
		text += '￼';
	};
	const paragraph = (parts: (string | typeof IMAGE)[]): Element => {
		const start = at;
		const elements = parts.map((part) => {
			const from = at;
			if (part === IMAGE) {
				mark();
				return {startIndex: from, endIndex: at, inlineObjectElement: {inlineObjectId: 'kix.image1'}};
			}
			at += part.length;
			text += part;
			return {startIndex: from, endIndex: at, textRun: {content: part, textStyle: {}}};
		});
		return {startIndex: start, endIndex: at, paragraph: {elements, paragraphStyle: {namedStyleType: 'NORMAL_TEXT'}}};
	};
	const content: Element[] = [{endIndex: 1, sectionBreak: {}}];
	for (const block of blocks) {
		const start = at;
		if ('paragraph' in block) {
			content.push(paragraph(block.paragraph));
			continue;
		}
		if ('table' in block) {
			mark();
			const tableRows = block.table.map((row) => {
				mark();
				return {tableCells: row.map((cell) => (mark(), {content: [paragraph([`${cell}\n`])]}))};
			});
			content.push({startIndex: start, endIndex: at, table: {rows: tableRows.length, columns: block.table[0]?.length ?? 0, tableRows}});
			continue;
		}
		mark();
		const paragraphs = block.contents.map((line) => paragraph([`${line}\n`]));
		content.push({startIndex: start, endIndex: at, tableOfContents: {content: paragraphs}});
	}
	return {content, text};
}

const PLAN: Block[] = [
	{paragraph: ['Launch plan\n']},
	{contents: ['Launch plan', 'Budget']},
	{paragraph: ['We ship the ', 'beta', ' on Friday.\n']},
	{paragraph: ['Owner: Dana Reyes', IMAGE, ' signs off.\n']},
	{
		table: [
			['Budget', '12,000'],
			['Team', 'Four people'],
		],
	},
	{paragraph: ['Party 😀 after launch.\n']},
	{paragraph: ['The end. The end.\n']},
];

// The fake Docs and Drive: the document at its revision, the batches it took, and what the
// history asks of Drive: the document as a file, and its latest revision.
type FakeTab = {id: string; title: string; blocks: Block[]; children: {id: string; title: string; blocks: Block[]}[]};
const ONE_TAB = (blocks: Block[]): FakeTab[] => [{id: 't.0', title: 'Tab 1', blocks, children: []}];
const docs = {tabs: ONE_TAB(PLAN), revision: 'rev-1', batches: [] as {requests: DocumentRequest[]; writeControl: {requiredRevisionId: string}}[]};
const google = {requests: [] as {method: string; url: URL; body: string}[]};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const method = init?.method ?? 'GET';
	const body = typeof init?.body === 'string' ? init.body : '';
	google.requests.push({method, url, body});
	const path = decodeURIComponent(url.pathname);
	if (path === '/drive/v3/files/1Plan') {
		return Response.json({id: '1Plan', name: 'Launch plan', mimeType: 'application/vnd.google-apps.document'});
	}
	if (path === '/drive/v3/files/1Plan/export') {
		return new Response('docx of the launch plan');
	}
	if (path === '/drive/v3/files/1Plan/revisions') {
		return Response.json({revisions: [{id: `d${docs.batches.length + 1}`}]});
	}
	if (path === '/v1/documents/1Plan' && method === 'GET') {
		const tabs = docs.tabs.map(({id, title, blocks, children}) => ({
			tabProperties: {tabId: id, title},
			documentTab: {body: {content: documentOf(blocks).content}},
			childTabs: children.map((child) => ({tabProperties: {tabId: child.id, title: child.title}, documentTab: {body: {content: documentOf(child.blocks).content}}})),
		}));
		return Response.json({documentId: '1Plan', title: 'Launch plan', revisionId: docs.revision, tabs});
	}
	if (path === '/v1/documents/1Plan:batchUpdate') {
		const batch = JSON.parse(body);
		if (batch.writeControl?.requiredRevisionId !== docs.revision) {
			// As Google answers it.
			return Response.json({error: {code: 400, message: "The required revision ID 'rev-1' does not match the latest revision.", status: 'INVALID_ARGUMENT'}}, {status: 400});
		}
		docs.batches.push(batch);
		docs.revision = `rev-${docs.batches.length + 1}`;
		return Response.json({documentId: '1Plan', replies: batch.requests.map(() => ({})), writeControl: {requiredRevisionId: docs.revision}});
	}
	return Response.json({error: {code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND'}}, {status: 404});
}) as typeof fetch);

beforeEach(() => {
	docs.tabs = ONE_TAB(PLAN);
	docs.revision = 'rev-1';
	docs.batches = [];
	google.requests = [];
	history.copied = true;
	history.kept = [];
	history.logged = [];
});

// The body's text once a batch's text changes are made to it, one after another, as Docs makes them.
function applied(text: string, requests: DocumentRequest[]): string {
	return requests.reduce((now, request) => {
		if ('insertText' in request) {
			const {location, text: inserted} = request.insertText;
			return now.slice(0, location.index) + inserted + now.slice(location.index);
		}
		if ('deleteContentRange' in request) {
			const {startIndex, endIndex} = request.deleteContentRange.range;
			return now.slice(0, startIndex) + now.slice(endIndex);
		}
		return now;
	}, text);
}

function edited(): string {
	return applied(documentOf(PLAN).text, docs.batches[0]?.requests ?? []);
}

// Where text is in the fake document's body.
function indexOf(find: string): number {
	return documentOf(PLAN).text.indexOf(find);
}

describe('reading a document', () => {
	test('answers its text paragraph by paragraph, a table’s cells too, with the revision it is at, and leaves out the table of contents', async () => {
		const {runDocsRead} = await import('./google-docs');
		const answer = (await runDocsRead(run({id: 'https://docs.google.com/document/d/1Plan/edit'}))).unwrap();

		expect(answer).toBe(
			[
				'“Launch plan”, at revision rev-1, which docs_edit takes as revision.',
				'Link: https://docs.google.com/document/d/1Plan/edit',
				'￼ stands for what isn’t text, as an image or a chip; no find reaches across one.',
				'',
				'Launch plan',
				'We ship the beta on Friday.',
				'Owner: Dana Reyes￼ signs off.',
				'Budget',
				'12,000',
				'Team',
				'Four people',
				'Party 😀 after launch.',
				'The end. The end.',
				'',
			].join('\n'),
		);
		expect(google.requests.map((request) => [request.method, request.url.pathname, request.url.searchParams.get('fields')])).toEqual([['GET', '/v1/documents/1Plan', 'title,revisionId,tabs']]);
	});

	test('a document that isn’t Google’s never reaches Google', async () => {
		const {runDocsRead} = await import('./google-docs');
		const result = await runDocsRead(run({id: 'https://example.com/document/d/1Plan'}));

		expect(refusal(result)).toBe('validation_error: Say which document as id: its id, as files_list gives it, or its link');
		expect(google.requests).toEqual([]);
	});
});

describe('editing a document', () => {
	test('replaces, writes before and after, and styles text found once, in one batch at the revision read, back to front', async () => {
		const {runDocsEdit} = await import('./google-docs');
		const answer = (
			await runDocsEdit(
				run({
					id: '1Plan',
					revision: 'rev-1',
					edits: [
						{find: 'beta', replace: 'first release'},
						{find: 'on Friday', insertAfter: ' at noon'},
						{find: 'Owner:', insertBefore: 'Release '},
						{find: 'Launch plan\n', style: {heading: 'Heading 1', bold: true, link: 'https://example.com/plan'}},
					],
				}),
			)
		).unwrap();

		expect(answer).toBe('Made all 4 edits to “Launch plan”. It is at revision rev-2 now, which docs_edit takes for more edits.\nLink: https://docs.google.com/document/d/1Plan/edit');
		const [batch] = docs.batches;
		expect(batch?.writeControl).toEqual({requiredRevisionId: 'rev-1'});
		// Styles first, at the places found, then the text from the end back.
		const heading = {startIndex: 1, endIndex: 13, tabId: 't.0'};
		expect(batch?.requests.slice(0, 2)).toEqual([
			{updateTextStyle: {range: heading, textStyle: {bold: true, link: {url: 'https://example.com/plan'}}, fields: 'bold,link'}},
			{updateParagraphStyle: {range: heading, paragraphStyle: {namedStyleType: 'HEADING_1'}, fields: 'namedStyleType'}},
		]);
		const beta = indexOf('beta');
		expect(batch?.requests.slice(2)).toEqual([
			{insertText: {location: {index: indexOf('Owner:'), tabId: 't.0'}, text: 'Release '}},
			{insertText: {location: {index: indexOf('on Friday') + 'on Friday'.length, tabId: 't.0'}, text: ' at noon'}},
			// The new text written after the found text's first character, so it takes its style, then the rest deleted.
			{insertText: {location: {index: beta + 1, tabId: 't.0'}, text: 'first release'}},
			{deleteContentRange: {range: {startIndex: beta + 1 + 'first release'.length, endIndex: beta + 4 + 'first release'.length, tabId: 't.0'}}},
			{deleteContentRange: {range: {startIndex: beta, endIndex: beta + 1, tabId: 't.0'}}},
		]);
		expect(edited()).toContain('We ship the first release on Friday at noon.\nRelease Owner: Dana Reyes￼ signs off.\n');
	});

	test('finds text across the runs a paragraph’s styles split it into, and across paragraphs', async () => {
		const {runDocsEdit} = await import('./google-docs');
		await runDocsEdit(
			run({
				id: '1Plan',
				revision: 'rev-1',
				edits: [
					{find: 'the beta on', replace: 'v2 on'},
					{find: 'Friday.\nOwner', replace: 'Monday.\nLead'},
				],
			}),
		);

		expect(edited()).toContain('We ship v2 on Monday.\nLead: Dana Reyes');
	});

	test('a character past UTF-16’s first plane is never split: the new text is written after the whole of it', async () => {
		const {runDocsEdit} = await import('./google-docs');
		await runDocsEdit(
			run({
				id: '1Plan',
				revision: 'rev-1',
				edits: [
					{find: '😀 after', replace: '🎉 after'},
					{find: 'Team', replace: ''},
				],
			}),
		);

		const party = indexOf('😀');
		expect(docs.batches[0]?.requests[0]).toEqual({insertText: {location: {index: party + 2, tabId: 't.0'}, text: '🎉 after'}});
		expect(docs.batches[0]?.requests.at(-1)).toEqual({deleteContentRange: {range: {startIndex: indexOf('Team'), endIndex: indexOf('Team') + 4, tabId: 't.0'}}});
		expect(edited()).toContain('Party 🎉 after launch.');
		expect(edited()).toContain('￼￼\n￼Four people');
	});

	test('is logged in the document’s history as an edit, with Drive’s revisions before and after', async () => {
		const {runDocsEdit} = await import('./google-docs');
		await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', replace: 'release'}]}));

		expect(history.kept).toEqual([]);
		expect(history.logged).toEqual([expect.objectContaining({kind: 'edit', fileId: '1Plan', name: 'Launch plan', beforeVersion: null, beforeRevision: 'd1', afterRevision: 'd2', undo: null})]);
	});

	test('a task’s first change to the document keeps its revision as a version before the edit is made', async () => {
		history.copied = false;
		const {runDocsEdit} = await import('./google-docs');
		await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', replace: 'release'}]}));

		expect(history.kept).toEqual([expect.objectContaining({blobId: 'blob-1', size: 23, sourceRevision: 'd1', sourceType: 'application/vnd.google-apps.document'})]);
		expect(history.logged).toEqual([expect.objectContaining({kind: 'edit', beforeVersion: 'version-1'})]);
	});

	test('an edit on an older revision than the document’s is turned down by Docs, and nothing is logged', async () => {
		docs.revision = 'rev-7';
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', replace: 'release'}]}));

		expect(refusal(result)).toBe(
			'conflict: The document changed since revision rev-1 was read, or that revision is too old: no edit was made. Read it again with docs_read, and make the edits on what it holds now, with its new revision.',
		);
		expect(docs.batches).toEqual([]);
		expect(history.logged).toEqual([]);
	});

	test('text that appears nowhere, or more than once, is turned down with how often it appears, every edit at once, and nothing is sent', async () => {
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(
			run({
				id: '1Plan',
				revision: 'rev-1',
				edits: [
					{find: 'Launch plan', replace: 'Plan'},
					{find: 'Budget\n12,000', replace: 'Budget: 12,000'},
					{find: 'Dana Reyes signs', replace: 'Dana signs'},
					{find: 'beta', replace: 'release'},
					{find: 'The end. The end.\n', replace: 'Fin.'},
					{find: 'The end', replace: 'Fin'},
					{find: 'friday', replace: 'Monday'},
				],
			}),
		);

		expect(refusal(result)).toBe(
			[
				// Edit 1's text is in the table of contents too, which is left out, so it is found once.
				'validation_error: No edit was made:',
				'Edit 2: “Budget\n12,000” appears nowhere in the document. find matches the text as docs_read answers it, exactly, its case too, and never across an image, a chip or a table’s cells.',
				'Edit 3: “Dana Reyes signs” appears nowhere in the document. find matches the text as docs_read answers it, exactly, its case too, and never across an image, a chip or a table’s cells.',
				'Edit 5: the line break that ends the document can’t be replaced. Leave it out of find.',
				'Edit 6: “The end” appears 2 times in the document. Make find longer, with the words around it, so it appears once.',
				'Edit 7: “friday” appears nowhere in the document. find matches the text as docs_read answers it, exactly, its case too, and never across an image, a chip or a table’s cells.',
			].join('\n'),
		);
		expect(docs.batches).toEqual([]);
		expect(history.logged).toEqual([]);
	});

	test('text found twice where one find overlaps the other counts both', async () => {
		docs.tabs = ONE_TAB([{paragraph: ['aaa\n']}]);
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'aa', replace: 'b'}]}));

		expect(refusal(result)).toContain('“aa” appears 2 times');
	});

	test('two edits that find the same text are turned down, to be made one', async () => {
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(
			run({
				id: '1Plan',
				revision: 'rev-1',
				edits: [
					{find: 'ship the beta', replace: 'release'},
					{find: 'beta on', style: {bold: true}},
				],
			}),
		);

		expect(refusal(result)).toBe('validation_error: No edit was made: Edit 1 and Edit 2 find the same text. Make them one edit.');
		expect(docs.batches).toEqual([]);
	});

	test('edits that don’t say one thing to do, a style that sets nothing, a link that isn’t one, or a find holding ￼ never reach Google', async () => {
		const {runDocsEdit} = await import('./google-docs');
		const edit = (one: Record<string, unknown>) => runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', ...one}]}));
		const refusals = [
			await edit({}),
			await edit({replace: 'x', insertAfter: 'y'}),
			await edit({style: {}}),
			await edit({style: {link: 'not a link'}}),
			await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'Reyes￼', replace: 'x'}]})),
		].map(refusal);

		expect(refusals).toEqual([
			'validation_error: Edit 1 takes find, and one of replace, insertBefore, insertAfter or style, not find alone',
			'validation_error: Edit 1 takes find, and one of replace, insertBefore, insertAfter or style, not replace and insertAfter',
			'validation_error: Edit 1’s style sets nothing: give bold, italic, underline, link or heading',
			'validation_error: Edit 1’s link isn’t a web address: give it whole, as https://example.com/page, or "" to take a link off',
			'validation_error: Edit 1’s find holds ￼, which stands for what isn’t text: find text on one side of it',
		]);
		expect(google.requests).toEqual([]);
	});

	test('params of the wrong shape are turned down with what docs_edit takes', async () => {
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', bold: true}]}));

		expect(refusal(result)).toStartWith('validation_error: docs_edit takes id, revision and edits, each find, and one of replace, insertBefore, insertAfter or style, and tab where wanted:\n');
		expect(google.requests).toEqual([]);
	});

	test('a link given as "" is taken off, and bold false takes bold off', async () => {
		const {runDocsEdit} = await import('./google-docs');
		await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', style: {link: '', bold: false}}]}));

		expect(docs.batches[0]?.requests).toEqual([{updateTextStyle: {range: {startIndex: indexOf('beta'), endIndex: indexOf('beta') + 4, tabId: 't.0'}, textStyle: {bold: false}, fields: 'bold,link'}}]);
	});
});

describe('a document with tabs', () => {
	const TABS: FakeTab[] = [
		{id: 't.0', title: 'Plan', blocks: [{paragraph: ['We ship the beta on Friday.\n']}], children: [{id: 't.child', title: 'Risks', blocks: [{paragraph: ['The beta may slip.\n']}]}]},
		{id: 't.notes', title: 'Notes', blocks: [{paragraph: ['Ask Dana about the launch.\n']}], children: []},
	];

	test('reads its first tab, or the one asked for by its title or id, and says what its other tabs are', async () => {
		docs.tabs = TABS;
		const {runDocsRead} = await import('./google-docs');

		expect((await runDocsRead(run({id: '1Plan'}))).unwrap()).toBe(
			[
				'“Launch plan”, at revision rev-1, which docs_edit takes as revision.',
				'Link: https://docs.google.com/document/d/1Plan/edit?tab=t.0',
				'This is the tab “Plan” (t.0). Its other tabs are “Plan › Risks” (t.child), “Notes” (t.notes): docs_read reads one with tab, and a docs_edit edit names the one it is in with tab.',
				'',
				'We ship the beta on Friday.\n',
			].join('\n'),
		);
		expect((await runDocsRead(run({id: '1Plan', tab: 'Risks'}))).unwrap()).toEndWith('\n\nThe beta may slip.\n');
		expect((await runDocsRead(run({id: '1Plan', tab: 't.notes'}))).unwrap()).toEndWith('\n\nAsk Dana about the launch.\n');
		expect(refusal(await runDocsRead(run({id: '1Plan', tab: 'Budget'})))).toBe(
			'validation_error: The document has no tab “Budget”; its tabs are “Plan” (t.0), “Plan › Risks” (t.child), “Notes” (t.notes)',
		);
	});

	test('finds text once across every tab, or in the tab an edit names, and edits it in that tab', async () => {
		docs.tabs = TABS;
		const {runDocsEdit} = await import('./google-docs');
		const refused = await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'beta', replace: 'release'}]}));
		expect(refusal(refused)).toBe(
			'validation_error: No edit was made:\nEdit 1: “beta” appears 2 times in the document, in the tabs “Plan” (t.0), “Plan › Risks” (t.child). Make find longer, with the words around it, so it appears once, or name its tab with tab.',
		);

		(
			await runDocsEdit(
				run({
					id: '1Plan',
					revision: 'rev-1',
					edits: [
						{find: 'beta', tab: 'Risks', replace: 'release'},
						{find: 'Dana', replace: 'Sam'},
						{find: 'beta', tab: 't.0', style: {bold: true}},
					],
				}),
			)
		).unwrap();
		expect(docs.batches[0]?.requests).toEqual([
			{updateTextStyle: {range: {startIndex: 13, endIndex: 17, tabId: 't.0'}, textStyle: {bold: true}, fields: 'bold'}},
			{insertText: {location: {index: 6, tabId: 't.notes'}, text: 'Sam'}},
			{deleteContentRange: {range: {startIndex: 9, endIndex: 12, tabId: 't.notes'}}},
			{deleteContentRange: {range: {startIndex: 5, endIndex: 6, tabId: 't.notes'}}},
			{insertText: {location: {index: 6, tabId: 't.child'}, text: 'release'}},
			{deleteContentRange: {range: {startIndex: 13, endIndex: 16, tabId: 't.child'}}},
			{deleteContentRange: {range: {startIndex: 5, endIndex: 6, tabId: 't.child'}}},
		]);
	});

	test('text named in a tab it isn’t in, or in a tab the document hasn’t, is turned down', async () => {
		docs.tabs = TABS;
		const {runDocsEdit} = await import('./google-docs');
		const result = await runDocsEdit(
			run({
				id: '1Plan',
				revision: 'rev-1',
				edits: [
					{find: 'Dana', tab: 'Plan', replace: 'Sam'},
					{find: 'Dana', tab: 'Budget', replace: 'Sam'},
				],
			}),
		);

		expect(refusal(result)).toBe(
			[
				'validation_error: No edit was made:',
				'Edit 1: “Dana” appears nowhere in the tab “Plan”. find matches the text as docs_read answers it, exactly, its case too, and never across an image, a chip or a table’s cells.',
				'Edit 2: The document has no tab “Budget”; its tabs are “Plan” (t.0), “Plan › Risks” (t.child), “Notes” (t.notes)',
			].join('\n'),
		);
		expect(docs.batches).toEqual([]);
	});
});

test('edits that can’t be placed in a document changed since the revision read are turned down as stale, to read it again', async () => {
	docs.revision = 'rev-7';
	const {runDocsEdit} = await import('./google-docs');
	const result = await runDocsEdit(run({id: '1Plan', revision: 'rev-1', edits: [{find: 'the beta that was cut', replace: 'release'}]}));

	expect(refusal(result)).toStartWith('conflict: The document changed since revision rev-1 was read');
	expect(docs.batches).toEqual([]);
});
