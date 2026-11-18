import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// The history every write goes through (google-history.ts), kept in memory: each task has its copy
// already, and the changes logged are kept to look at.
type Logged = {kind: string; fileId: string; name: string; beforeRevision?: string | null; afterRevision?: string | null; undo?: unknown};
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

function ranges(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'ranges');
	if (!found) {
		throw new Error('No ranges collection');
	}
	return found;
}

// What a refusal says, or its kind where it says nothing of its own.
function messageOf<T>(result: Result<T, ApiError> | undefined): string | null {
	if (!result || result.isOk()) {
		return null;
	}
	return ('message' in result.error && result.error.message) || result.error.kind;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const target = {
	connection: {
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
	},
	collection: ranges(),
	by: {agentId: 'agent-1', taskId: 'task-1'},
};

type Request = {method: string; url: URL; body: string};

const google = {requests: [] as Request[], answer: (_request: Request): Response | null => null};

// The cells of the Q1 Sales tab as they were entered, before a write and after it, the second
// written as the write's answer says.
const cells = {
	before: [[{stringValue: 'Rent'}, {numberValue: 1200}, {formulaValue: '=B2*2'}], [{stringValue: '=not a formula'}]],
	after: [
		[{stringValue: 'Rent'}, {numberValue: 1200}, {formulaValue: '=B2*2'}],
		[{stringValue: 'Food, drink'}, {numberValue: 300}, {formulaValue: '=B3*2'}],
	],
};

// What a write's history asks of Drive and Sheets: the spreadsheet as a file, its revisions, its
// tabs, and the cells written, before the write and after it.
function historyAnswer(request: Request): Response | null {
	const path = decodeURIComponent(request.url.pathname);
	const writes = google.requests.filter((sent) => sent.method !== 'GET').length;
	if (/^\/drive\/v3\/files\/[^/]+$/.test(path)) {
		return Response.json({id: '1BudgetSheet_x-9', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet'});
	}
	if (path.endsWith('/revisions')) {
		return Response.json({revisions: [{id: `r${writes + 1}`}]});
	}
	if (/^\/v4\/spreadsheets\/[^/]+$/.test(path) && request.url.searchParams.has('ranges')) {
		return Response.json({sheets: [{data: [{startRow: 1, rowData: (writes === 0 ? cells.before : cells.after).map((values) => ({values: values.map((userEnteredValue) => ({userEnteredValue}))}))}]}]});
	}
	if (/^\/v4\/spreadsheets\/[^/]+$/.test(path)) {
		return Response.json({
			sheets: [
				{properties: {sheetId: 7, title: 'Q1 Sales', gridProperties: {rowCount: 100, columnCount: 10}}},
				{properties: {sheetId: 0, title: 'Sheet1', gridProperties: {rowCount: 1000, columnCount: 26}}},
			],
		});
	}
	return null;
}

// The requests that read or write values, as a range's read and write make them.
function valueRequests(): Request[] {
	return google.requests.filter((request) => request.url.pathname.includes('/values/'));
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const request = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	const custom = google.answer(request);
	if (custom) {
		return custom;
	}
	const history = historyAnswer(request);
	if (history) {
		return history;
	}
	if (request.method === 'PUT') {
		const {range, values} = JSON.parse(request.body);
		return Response.json({
			updatedRange: "'Q1 Sales'!A2:C3",
			updatedRows: values.length,
			updatedData: {
				range,
				values: [
					['Rent', '1,200', '2,400'],
					['Food, drink', '300', '600'],
				],
			},
		});
	}
	return Response.json({
		range: "'Q1 Sales'!A1:C3",
		majorDimension: 'ROWS',
		values: [
			['Item', 'Amount'],
			['Rent', 1200],
			['Say "hi"', ''],
		],
	});
}) as typeof fetch);

beforeEach(() => {
	history.logged = [];
	google.requests = [];
	google.answer = () => null;
});

const LINK = 'https://docs.google.com/spreadsheets/d/1BudgetSheet_x-9/edit?gid=0#gid=0';

describe('reading a range', () => {
	test('a range of a spreadsheet given by its link answers its values as CSV', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const record = (await rangesConnector.newCommands?.read?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A1:C3", values: ''}))?.unwrap();

		const [request] = google.requests;
		expect(request?.url.pathname).toBe("/v4/spreadsheets/1BudgetSheet_x-9/values/'Q1%20Sales'!A1%3AC3");
		expect(record?.values).toEqual({spreadsheet: '1BudgetSheet_x-9', range: "'Q1 Sales'!A1:C3", rows: '3 rows', result: 'Item,Amount\nRent,1200\n"Say ""hi""",'});
	});

	test('a range of more than 1000 rows answers the first 1000, saying how many there are', async () => {
		google.answer = () => Response.json({range: "'Q1 Sales'!A1:A1500", majorDimension: 'ROWS', values: Array.from({length: 1500}, (_, index) => [String(index + 1)])});
		const {rangesConnector} = await import('./google-ranges');
		const record = (await rangesConnector.newCommands?.read?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A:A", values: ''}))?.unwrap();

		expect(record?.values.rows).toBe('The first 1000 of 1500 rows: read the rest as a range starting below them');
		expect(record?.values.result?.split('\n')).toHaveLength(1000);
	});

	test('a spreadsheet is taken by its id or a Drive link, and a range without a tab or in an unquoted one', async () => {
		const {rangesConnector} = await import('./google-ranges');
		await rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'Sheet1!B:B'});
		await rangesConnector.newCommands?.read?.(target, {spreadsheet: 'https://drive.google.com/open?id=1BudgetSheet', range: 'A1:C9'});
		await rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: '$A$1:$F$20'});
		await rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'Übersicht!A1'});

		expect(google.requests.map((request) => decodeURIComponent(request.url.pathname))).toEqual([
			'/v4/spreadsheets/1BudgetSheet/values/Sheet1!B:B',
			'/v4/spreadsheets/1BudgetSheet/values/A1:C9',
			'/v4/spreadsheets/1BudgetSheet/values/$A$1:$F$20',
			'/v4/spreadsheets/1BudgetSheet/values/Übersicht!A1',
		]);
	});

	test('a range that isn’t A1 notation, or a spreadsheet that isn’t Google’s, never reaches Google', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const refusals = await Promise.all([
			rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'A1:C3?fields=*'}),
			rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: "'Q1'!A1/../../x"}),
			rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: ''}),
			rangesConnector.newCommands?.read?.(target, {spreadsheet: 'https://evil.example.com/d/1BudgetSheet', range: 'A1'}),
			rangesConnector.newCommands?.read?.(target, {spreadsheet: '../1BudgetSheet', range: 'A1'}),
		]);

		expect(refusals.map((result) => result?.isErr() && result.error.kind)).toEqual(['validation_error', 'validation_error', 'validation_error', 'validation_error', 'validation_error']);
		expect(google.requests).toEqual([]);
	});

	test('Google turning a range down is passed on in its own words', async () => {
		const {rangesConnector} = await import('./google-ranges');
		google.answer = () => Response.json({error: {code: 400, message: "Unable to parse range: 'Nope'!A1", status: 'INVALID_ARGUMENT'}}, {status: 400});
		const result = await rangesConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: "'Nope'!A1"});

		expect(result?.isErr() && result.error).toEqual({kind: 'validation_error', statusCode: 400, message: "Google: Unable to parse range: 'Nope'!A1"});
	});
});

describe('writing a range', () => {
	test('CSV is written as if typed in, and the answer is what the range holds now', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const record = (await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A2", values: 'Rent,"1,200",=B2*2\n"Food, drink",300,=B3*2\n'}))?.unwrap();

		const [request] = valueRequests();
		expect(request?.method).toBe('PUT');
		expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({valueInputOption: 'USER_ENTERED', includeValuesInResponse: 'true', responseValueRenderOption: 'FORMATTED_VALUE'});
		expect(JSON.parse(request?.body ?? '')).toEqual({
			range: "'Q1 Sales'!A2",
			majorDimension: 'ROWS',
			values: [
				['Rent', '1,200', '=B2*2'],
				['Food, drink', '300', '=B3*2'],
			],
		});
		expect(record?.values).toEqual({spreadsheet: '1BudgetSheet_x-9', range: "'Q1 Sales'!A2:C3", rows: '2 rows', result: 'Rent,"1,200","2,400"\n"Food, drink",300,600'});
	});

	test('an empty value in quotes empties the cell', async () => {
		const {rangesConnector} = await import('./google-ranges');
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: '""'});

		expect(JSON.parse(valueRequests()[0]?.body ?? '').values).toEqual([['']]);
	});

	test('no values, or a quote never closed, is turned down', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const empty = await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: ''});
		const unclosed = await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: '"Rent,1200'});

		expect(messageOf(empty)).toBe('Write the values as CSV, one row a line; "" empties a cell');
		expect(messageOf(unclosed)).toBe('The CSV has a quote that is never closed');
		expect(google.requests).toEqual([]);
	});
});

describe('the history of a range written', () => {
	test('the cells written are kept as they were entered before and after, a formula told from text, for an exact undo', async () => {
		const {rangesConnector} = await import('./google-ranges');
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A2", values: 'Rent,"1,200",=B2*2\n"Food, drink",300,=B3*2'});

		const reads = google.requests.filter((request) => request.url.searchParams.has('ranges')).map((request) => request.url.searchParams.get('ranges'));
		expect(reads).toEqual(["'Q1 Sales'!A2:C3", "'Q1 Sales'!A2:C3"]);
		expect(history.logged).toEqual([
			expect.objectContaining({
				kind: 'edit',
				fileId: '1BudgetSheet_x-9',
				name: 'Budget 2026',
				beforeRevision: 'r1',
				afterRevision: 'r2',
				undo: {
					kind: 'sheets_cells',
					sheetId: 7,
					tab: 'Q1 Sales',
					range: 'A2:C3',
					before: [
						[{value: 'Rent'}, {value: 1200}, {formula: '=B2*2'}],
						[{value: '=not a formula'}, null, null],
					],
					after: [
						[{value: 'Rent'}, {value: 1200}, {formula: '=B2*2'}],
						[{value: 'Food, drink'}, {value: 300}, {formula: '=B3*2'}],
					],
				},
			}),
		]);
	});

	test('a range without a tab is in the first one, from its first cell, a whole column from its top', async () => {
		const {rangesConnector} = await import('./google-ranges');
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'B:B', values: '1\n2'});
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'Sheet1!$C$5:$D$9', values: '1,2'});

		const reads = google.requests.filter((request) => request.url.searchParams.has('ranges')).map((request) => request.url.searchParams.get('ranges'));
		expect(reads).toEqual(["'Q1 Sales'!B1:B2", "'Q1 Sales'!B1:B2", "'Sheet1'!C5:D5", "'Sheet1'!C5:D5"]);
		expect(history.logged.map((entry) => (entry.undo as {sheetId: number} | null)?.sheetId)).toEqual([7, 0]);
	});

	test('a range past the tab’s grid, a named range or a tab not there, is written and logged without an undo', async () => {
		const {rangesConnector} = await import('./google-ranges');
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!K1", values: '1'});
		await rangesConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'Totals', values: '1'});

		expect(google.requests.filter((request) => request.url.searchParams.has('ranges'))).toEqual([]);
		expect(valueRequests().map((request) => request.method)).toEqual(['PUT', 'PUT']);
		expect(history.logged.map((entry) => [entry.kind, entry.undo])).toEqual([
			['edit', null],
			['edit', null],
		]);
	});

	test('a write with no one to log it as never reaches Sheets', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const {by: _by, ...unknown} = target;
		const result = await rangesConnector.newCommands?.write?.(unknown, {spreadsheet: LINK, range: 'A1', values: '1'});

		expect(result?.isErr() && result.error.kind).toBe('internal_error');
		expect(google.requests).toEqual([]);
	});
});
