import {createHash} from 'node:crypto';
import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {JsonValue} from '@proxy/utils/harness';
import type {FileUndo} from '@proxy/db/file-undo';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// The history every change goes through (google-history.ts), kept in memory: each task has its
// copy already, and the changes logged are kept to look at.
type Logged = {kind: string; fileId: string; name: string; beforeRevision?: string | null; afterRevision?: string | null; undo?: FileUndo | null};
const history = {logged: [] as Logged[]};
mock.module('@proxy/db/files', () => ({
	hasTaskCopied: mock(async () => Ok(true)),
	getLatestFileVersion: mock(async () => Ok(null)),
	recordFileVersion: mock(),
	logFileChange: mock(async (_change: object, entry: Logged) => {
		history.logged.push(entry);
		return Ok({change: {id: `change-${history.logged.length}`, ...entry}, version: null});
	}),
	createFileBlob: mock(),
	completeFileBlob: mock(),
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

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

// The fake Sheets and Drive: the spreadsheet's tabs, the structural changes it took, and what
// the history asks of Drive, the spreadsheet as a file and its latest revision.
type Tab = {sheetId: number; title: string; rowCount: number; columnCount: number};
const sheets = {tabs: [] as Tab[], requests: [] as JsonValue[], values: {} as Record<string, string[][]>};
const google = {requests: [] as {method: string; url: URL}[]};

const TABS: Tab[] = [
	{sheetId: 0, title: 'Q1 Sales', rowCount: 100, columnCount: 26},
	{sheetId: 7, title: 'Notes', rowCount: 10, columnCount: 4},
];

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const method = init?.method ?? 'GET';
	google.requests.push({method, url});
	const path = decodeURIComponent(url.pathname);
	if (path === '/drive/v3/files/1Budget') {
		return Response.json({id: '1Budget', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet'});
	}
	if (path === '/drive/v3/files/1Budget/revisions') {
		return Response.json({revisions: [{id: `r${sheets.requests.length + 1}`}]});
	}
	if (path === '/v4/spreadsheets/1Budget' && method === 'GET') {
		return Response.json({sheets: sheets.tabs.map(({sheetId, title, rowCount, columnCount}) => ({properties: {sheetId, title, gridProperties: {rowCount, columnCount}}}))});
	}
	if (path.startsWith('/v4/spreadsheets/1Budget/values/') && method === 'GET') {
		const range = path.slice('/v4/spreadsheets/1Budget/values/'.length);
		return Response.json({range, values: sheets.values[range] ?? []});
	}
	if (path === '/v4/spreadsheets/1Budget:batchUpdate') {
		const [request] = JSON.parse(typeof init?.body === 'string' ? init.body : '{}').requests;
		sheets.requests.push(request);
		if (request.addSheet) {
			return Response.json({replies: [{addSheet: {properties: {sheetId: 42, title: request.addSheet.properties.title, index: 2, gridProperties: {rowCount: 1000, columnCount: 26}}}}]});
		}
		return Response.json({replies: [{}]});
	}
	return Response.json({error: {code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND'}}, {status: 404});
}) as typeof fetch);

// What the fake tabs hold, by the range a delete reads, formulas as formulas.
const VALUES: Record<string, string[][]> = {
	"'Notes'!B:C": [
		['Owner', 'Due'],
		['Dana', '=TODAY()+3'],
	],
	"'Notes'": [
		['Topic', 'Owner', 'Due'],
		['Launch', 'Dana', '=TODAY()+3'],
	],
};

// A range's checksum, as a delete names it: what it holds, formulas as formulas, hashed short.
function checksumOf(values: string[][]): string {
	return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 8);
}

beforeEach(() => {
	sheets.tabs = TABS;
	sheets.values = VALUES;
	sheets.requests = [];
	google.requests = [];
	history.logged = [];
});

const LINK = 'https://docs.google.com/spreadsheets/d/1Budget/edit#gid=0';

const NO_UNDO = 'It has no exact undo: files_version_read reads the version kept from before this task’s first change to the spreadsheet (files_versions lists it), with what this took away.';

describe('inserting and deleting rows and columns', () => {
	test('rows are inserted at a row number, taking the format of the row above, and logged as an edit with no undo', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		const answer = (await runSheetsRows(run({spreadsheet: LINK, tab: 'Q1 Sales', insert: {start: 5, count: 3}}))).unwrap();

		expect(sheets.requests).toEqual([{insertDimension: {range: {sheetId: 0, dimension: 'ROWS', startIndex: 4, endIndex: 7}, inheritFromBefore: true}}]);
		expect(answer).toBe('Inserted 3 empty rows into “Q1 Sales” in “Budget 2026”, now rows 5 to 7; the rows from there on moved down.');
		expect(history.logged).toEqual([expect.objectContaining({kind: 'edit', fileId: '1Budget', name: 'Budget 2026', beforeRevision: 'r1', afterRevision: 'r2', undo: null})]);
	});

	test('columns are named by their letters, or their number, and the first row or column takes the format after it', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		const answers = [
			(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', delete: {start: 'b', count: 2}, dimension: 'columns', checksum: checksumOf(VALUES["'Notes'!B:C"] ?? [])}))).unwrap(),
			(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 1, count: 1}, dimension: 'columns'}))).unwrap(),
			(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', delete: {start: '3', count: 1}, checksum: checksumOf([])}))).unwrap(),
		];

		expect(sheets.requests).toEqual([
			{deleteDimension: {range: {sheetId: 7, dimension: 'COLUMNS', startIndex: 1, endIndex: 3}}},
			{insertDimension: {range: {sheetId: 7, dimension: 'COLUMNS', startIndex: 0, endIndex: 1}, inheritFromBefore: false}},
			{deleteDimension: {range: {sheetId: 7, dimension: 'ROWS', startIndex: 2, endIndex: 3}}},
		]);
		expect(answers.map((answer) => answer.split('; ')[0])).toEqual([
			'Deleted columns B to C of “Notes” in “Budget 2026”, with what they held',
			'Inserted an empty column into “Notes” in “Budget 2026”, now column A',
			'Deleted row 3 of “Notes” in “Budget 2026”, with what it held',
		]);
	});

	test('rows inserted one past the last are added at the end of the grid', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 11, count: 5}}));

		expect(sheets.requests).toEqual([{appendDimension: {sheetId: 7, dimension: 'ROWS', length: 5}}]);
	});

	test('rows past the grid, a tab not there, a column’s letters for rows, or neither or both of insert and delete never reach Sheets’ batchUpdate', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		const refusals = [
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', delete: {start: 9, count: 3}})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 12, count: 1}})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Summary', insert: {start: 1, count: 1}})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 'C', count: 1}})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes'})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 1, count: 1}, delete: {start: 1, count: 1}})),
			await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', insert: {start: 0, count: 1}})),
		].map(refusal);

		expect(refusals.slice(0, 6)).toEqual([
			'validation_error: “Notes” has 10 rows, so rows 9 to 11 can’t be deleted',
			'validation_error: “Notes” has 10 rows: insert at 11 at most, after its last',
			'validation_error: The spreadsheet has no tab “Summary”; its tabs are “Q1 Sales”, “Notes”',
			'validation_error: A row starts at its number, from 1, not “C”; give dimension columns for columns',
			'validation_error: sheets_rows takes one of insert or delete, each a start and a count',
			'validation_error: sheets_rows takes one of insert or delete, each a start and a count',
		]);
		expect(refusals[6]).toStartWith('validation_error: sheets_rows takes spreadsheet, tab, one of insert or delete');
		expect(sheets.requests).toEqual([]);
		expect(history.logged).toEqual([]);
	});
});

describe('a delete confirmed by the checksum of what it takes away', () => {
	test('a delete without the checksum is refused, saying what the rows hold and their checksum, and one with it is made', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		const asked = {spreadsheet: '1Budget', tab: 'Notes', delete: {start: 'B', count: 2}, dimension: 'columns'};
		const checksum = checksumOf(VALUES["'Notes'!B:C"] ?? []);

		expect(refusal(await runSheetsRows(run(asked)))).toBe(
			`validation_error: Nothing was deleted: a delete names the checksum of what it takes away. What it would take away, columns B to C of “Notes”, holds, formulas as formulas:\nOwner,Due\nDana,=TODAY()+3\nTo delete it, call sheets_rows again with checksum ${checksum}.`,
		);
		expect(sheets.requests).toEqual([]);
		expect(google.requests.find((request) => request.url.pathname.includes('/values/'))?.url.searchParams.get('valueRenderOption')).toBe('FORMULA');

		(await runSheetsRows(run({...asked, checksum: checksum.toUpperCase()}))).unwrap();
		expect(sheets.requests).toEqual([{deleteDimension: {range: {sheetId: 7, dimension: 'COLUMNS', startIndex: 1, endIndex: 3}}}]);
	});

	test('a checksum no longer of what is there, as when a row moved into the place since, is refused, saying what is there now', async () => {
		const {runSheetsRows, runSheetsTabs} = await import('./google-sheets');
		const old = checksumOf(VALUES["'Notes'!B:C"] ?? []);
		sheets.values = {...VALUES, "'Notes'!B:C": [['Owner', 'Due', 'Cost']]};

		expect(refusal(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', delete: {start: 'B', count: 2}, dimension: 'columns', checksum: old})))).toBe(
			`conflict: Nothing was deleted: what it would take away, columns B to C of “Notes”, changed since checksum ${old}. It now holds, formulas as formulas:\nOwner,Due,Cost\nTo delete it, call sheets_rows again with checksum ${checksumOf([['Owner', 'Due', 'Cost']])}.`,
		);
		expect(refusal(await runSheetsTabs(run({spreadsheet: '1Budget', delete: 'Notes', checksum: old})))).toStartWith(
			`conflict: Nothing was deleted: what it would take away, the tab “Notes”, 10 rows by 4 columns, changed since checksum ${old}. It now holds, formulas as formulas:\nTopic,Owner,Due\n`,
		);
		expect(sheets.requests).toEqual([]);
		expect(history.logged).toEqual([]);
	});

	test('empty rows are said to be empty, and a long delete shows its first rows and counts the rest', async () => {
		const {runSheetsRows} = await import('./google-sheets');
		const rows = Array.from({length: 25}, (_, at) => [`Row ${at + 1}`]);
		sheets.values = {...VALUES, "'Q1 Sales'!1:25": rows};

		expect(refusal(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Notes', delete: {start: 4, count: 2}})))).toStartWith(
			'validation_error: Nothing was deleted: a delete names the checksum of what it takes away. What it would take away, rows 4 to 5 of “Notes”, is empty.\n',
		);
		const long = refusal(await runSheetsRows(run({spreadsheet: '1Budget', tab: 'Q1 Sales', delete: {start: 1, count: 25}})));
		expect(long).toContain('\nRow 20\n(and 5 rows more)\nTo delete it');
		expect(long).not.toContain('Row 21');
	});
});

describe('adding and deleting tabs', () => {
	test('a tab is added after the others, and logged as an edit', async () => {
		const {runSheetsTabs} = await import('./google-sheets');
		const answer = (await runSheetsTabs(run({spreadsheet: LINK, add: 'Q2 Sales'}))).unwrap();

		expect(sheets.requests).toEqual([{addSheet: {properties: {title: 'Q2 Sales'}}}]);
		expect(answer).toBe('Added the tab “Q2 Sales” to “Budget 2026”, after its other tabs, with 1000 rows and 26 columns.');
		expect(history.logged).toEqual([expect.objectContaining({kind: 'edit', fileId: '1Budget', undo: null})]);
	});

	test('a tab is deleted by its title, saying it has no exact undo', async () => {
		const {runSheetsTabs} = await import('./google-sheets');
		const answer = (await runSheetsTabs(run({spreadsheet: LINK, delete: 'Notes', checksum: checksumOf(VALUES["'Notes'"] ?? [])}))).unwrap();

		expect(sheets.requests).toEqual([{deleteSheet: {sheetId: 7}}]);
		expect(answer).toBe(`Deleted the tab “Notes” from “Budget 2026”, with everything on it. ${NO_UNDO}`);
		expect(history.logged.map((entry) => entry.kind)).toEqual(['edit']);
	});

	test('a tab named as one there is, one not there, the only tab, or neither or both of add and delete, is turned down', async () => {
		const {runSheetsTabs} = await import('./google-sheets');
		const refusals = [
			await runSheetsTabs(run({spreadsheet: '1Budget', add: 'notes'})),
			await runSheetsTabs(run({spreadsheet: '1Budget', delete: 'Summary'})),
			await runSheetsTabs(run({spreadsheet: '1Budget'})),
			await runSheetsTabs(run({spreadsheet: '1Budget', add: 'A', delete: 'Notes'})),
		].map(refusal);
		sheets.tabs = TABS.slice(0, 1);
		refusals.push(refusal(await runSheetsTabs(run({spreadsheet: '1Budget', delete: 'Q1 Sales'}))));

		expect(refusals).toEqual([
			'conflict: The spreadsheet has a tab “notes” already: give the new one another name',
			'validation_error: The spreadsheet has no tab “Summary”; its tabs are “Q1 Sales”, “Notes”',
			'validation_error: sheets_tabs takes one of add or delete, a tab’s title',
			'validation_error: sheets_tabs takes one of add or delete, a tab’s title',
			'validation_error: “Q1 Sales” is the spreadsheet’s only tab, and a spreadsheet keeps one: add another first, or move the file to Trash',
		]);
		expect(sheets.requests).toEqual([]);
		expect(history.logged).toEqual([]);
	});
});
