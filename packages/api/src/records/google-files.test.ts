import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// The history every write goes through (google-history.ts), kept in memory: each task has its copy
// already, so no copy is taken here (google-history.test.ts takes them), and the changes logged are
// kept to look at.
type Logged = {kind: string; fileId: string; name: string; beforeName?: string | null; beforeRevision?: string | null; afterRevision?: string | null; undo?: unknown};
const history = {logged: [] as Logged[], down: false};
mock.module('@proxy/db/files', () => ({
	hasTaskCopied: mock(async () => Ok(true)),
	getLatestFileVersion: mock(async () => Ok(null)),
	recordFileVersion: mock(),
	logFileChange: mock(async (_change: object, entry: Logged) => {
		if (history.down) {
			return Err({kind: 'db_error', statusCode: 500, cause: new Error('the database is down')});
		}
		history.logged.push(entry);
		return Ok({change: {id: `change-${history.logged.length}`, ...entry}, version: null});
	}),
	createFileBlob: mock(),
	completeFileBlob: mock(),
}));

const logError = mock();
mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: logError},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function files(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'files');
	if (!found) {
		throw new Error('No files collection');
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
	collection: files(),
	by: {agentId: 'agent-1', taskId: 'task-1'},
};

const MY_DRIVE_ID = '0AFmyDriveRootUk9PVA';

const MIME = {
	folder: 'application/vnd.google-apps.folder',
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	presentation: 'application/vnd.google-apps.presentation',
};

type File = {id: string; name: string; mimeType: string; parents: string[]; content: string};

// A Drive as Google keeps it, changed by the writes a test makes: Projects in My Drive, holding a
// plan, a budget whose tab Q1 has a header row and two rows, and a deck.
type State = {files: Record<string, File>; grid: string[][]; made: number};

function fresh(): State {
	const file = (id: string, name: string, mimeType: string, content = ''): File => ({id, name, mimeType, parents: id === '1Projects' ? [MY_DRIVE_ID] : ['1Projects'], content});
	return {
		files: {
			'1Projects': file('1Projects', 'Projects', MIME.folder),
			'1Plan': file('1Plan', 'Launch plan', MIME.document, '# Launch plan\n\n- Ship it'),
			'1Budget': file('1Budget', 'Budget 2026', MIME.spreadsheet),
			'1Deck': file('1Deck', 'Board deck', MIME.presentation, 'Slide one'),
			'1Paper': file('1Paper', 'Paper.pdf', 'application/pdf'),
		},
		grid: [
			['Item', 'Amount', 'Status'],
			['Rent', '1,200', 'Paid'],
			['Food', '300', ''],
		],
		made: 0,
	};
}

let state = fresh();

// A body as text, and as the bytes it is, for a file uploaded as it is.
type Request = {method: string; url: URL; type: string; body: string; bytes: Buffer};

// Where Sheets puts an appended row: after the last rows holding anything, from the first column of
// the block they are in.
// What a search of Drive finds, by its query; none is asked for but in the searches' tests.
const google = {requests: [] as Request[], appendColumn: 'A', appendedTitle: 'Q1', found: null as ((q: string) => File[]) | null};

function driveFile(file: File): object {
	return {
		id: file.id,
		name: file.name,
		mimeType: file.mimeType,
		modifiedTime: '2026-10-08T08:00:00.000Z',
		owners: [{displayName: 'Alex Kim'}],
		webViewLink: `https://drive.google.com/open?id=${file.id}`,
		parents: file.parents,
	};
}

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'File not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

// The values of rows `from` to `to`, A1 ranges as `rowsRange` writes them.
function rowsOf(range: string): string[][] {
	const [, from = '1', to = '1'] = /!A(\d+):ZZ(\d+)$/.exec(range) ?? [];
	return state.grid.slice(Number(from) - 1, Number(to));
}

function cellOf(range: string): {row: number; column: number} {
	const [, letter = 'A', row = '1'] = /!([A-Z]+)(\d+)$/.exec(range) ?? [];
	return {row: Number(row), column: letter.charCodeAt(0) - 65};
}

// The metadata and the bytes of a multipart upload of a file as it is.
function uploadOf(request: Request): {metadata: {name: string; mimeType: string; parents: string[]}; type: string; bytes: Buffer} {
	const boundary = /boundary=(.+)$/.exec(request.type)?.[1] ?? '';
	const [, first = '', second = ''] = request.bytes.toString('latin1').split(`--${boundary}`);
	const [, json = '{}'] = first.split('\r\n\r\n');
	const at = second.indexOf('\r\n\r\n');
	return {metadata: JSON.parse(json.trim()), type: second.slice(0, at).replace('\r\nContent-Type: ', ''), bytes: Buffer.from(second.slice(at + 4).replace(/\r\n$/, ''), 'latin1')};
}

// The metadata and the content of a multipart upload of text.
function multipartOf(request: Request): {metadata: {name: string; mimeType: string; parents: string[]}; type: string; content: string} {
	const {metadata, type, bytes} = uploadOf(request);
	return {metadata, type, content: bytes.toString('utf8')};
}

// The cells of a range of the tab as they were entered, as Sheets answers them with the grid's
// data: from the range's first cell, the empty ones at the end of each row and of the rows left out.
function enteredOf(range: string): object {
	const [, first = 'A', top = '1', last = 'A', bottom = '1'] = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range) ?? [];
	const rows = state.grid.slice(Number(top) - 1, Number(bottom)).map((row) => row.slice(first.charCodeAt(0) - 65, last.charCodeAt(0) - 64));
	return {startRow: Number(top) - 1, startColumn: first.charCodeAt(0) - 65, rowData: rows.map((row) => ({values: row.map((cell) => (cell === '' ? {} : {userEnteredValue: {stringValue: cell}}))}))};
}

function make(name: string, mimeType: string, parents: string[], content: string): Response {
	state.made += 1;
	const file = {id: `1New${state.made}`, name, mimeType, parents, content};
	state.files[file.id] = file;
	return Response.json(driveFile(file));
}

function answer(request: Request): Response {
	const {method, url} = request;
	const path = decodeURIComponent(url.pathname);
	if (method === 'GET' && path === '/drive/v3/files' && google.found) {
		return Response.json({files: google.found(url.searchParams.get('q') ?? '').map(driveFile)});
	}
	if (path === '/drive/v3/files/root') {
		return Response.json({id: MY_DRIVE_ID});
	}
	if (method === 'POST' && path === '/drive/v3/files') {
		const {name, mimeType, parents} = JSON.parse(request.body);
		return make(name, mimeType, parents, '');
	}
	if (method === 'POST' && path === '/upload/drive/v3/files') {
		const {metadata, content} = multipartOf(request);
		return make(metadata.name, metadata.mimeType, metadata.parents, content);
	}
	const copied = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path)?.[1];
	const original = copied ? state.files[copied] : undefined;
	if (method === 'POST' && copied && !original) {
		return notFound();
	}
	if (method === 'POST' && original) {
		const {name, parents} = JSON.parse(request.body);
		return make(name, original.mimeType, parents, original.content);
	}
	const revised = /^\/drive\/v3\/files\/([^/]+)\/revisions$/.exec(path)?.[1];
	if (revised) {
		return Response.json({revisions: [{id: `${revised}-r1`}, {id: `${revised}-r${writes().length + 1}`}]});
	}
	const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path)?.[1];
	if (exported) {
		return new Response(state.files[exported]?.content ?? '');
	}
	const id = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
	const file = id ? state.files[id] : undefined;
	if (id && !file) {
		return notFound();
	}
	if (file && method === 'PATCH' && path.startsWith('/upload/')) {
		file.content = request.body;
		return Response.json(driveFile(file));
	}
	if (file && method === 'PATCH') {
		Object.assign(file, JSON.parse(request.body));
		return Response.json(driveFile(file));
	}
	if (file) {
		return Response.json(driveFile(file));
	}
	if (path === '/v4/spreadsheets/1Budget' && url.searchParams.has('ranges')) {
		return Response.json({sheets: [{data: [enteredOf(url.searchParams.get('ranges') ?? '')]}]});
	}
	if (path === '/v4/spreadsheets/1Budget') {
		return Response.json({sheets: [{properties: {sheetId: 0, title: 'Q1', gridProperties: {rowCount: 100, columnCount: 3}}}]});
	}
	if (path === '/v4/spreadsheets/1Budget/values:batchGet') {
		return Response.json({valueRanges: url.searchParams.getAll('ranges').map((range) => ({range, values: rowsOf(range)}))});
	}
	if (method === 'POST' && path.endsWith(':append')) {
		const [row = []] = JSON.parse(request.body).values;
		const shift = google.appendColumn.charCodeAt(0) - 65;
		state.grid.push([...Array.from({length: shift}, () => ''), ...row]);
		const at = state.grid.length;
		const last = String.fromCharCode(65 + shift + row.length - 1);
		return Response.json({updates: {updatedRange: `${google.appendedTitle}!${google.appendColumn}${at}:${last}${at}`, updatedRows: 1}});
	}
	if (method === 'PUT' && path.startsWith('/v4/spreadsheets/1Budget/values/')) {
		const {range, values} = JSON.parse(request.body);
		const [, row = '1'] = /!A(\d+):[A-Z]+\d+$/.exec(range) ?? [];
		state.grid[Number(row) - 1] = values[0];
		return Response.json({updatedRange: range, updatedData: {range, values}});
	}
	if (method === 'POST' && path === '/v4/spreadsheets/1Budget/values:batchUpdate') {
		for (const {range, values} of JSON.parse(request.body).data) {
			const {row, column} = cellOf(range);
			const cells = state.grid[row - 1] ?? [];
			cells[column] = values[0][0];
			state.grid[row - 1] = cells;
		}
		return Response.json({totalUpdatedCells: 1});
	}
	if (method === 'POST' && path === '/v4/spreadsheets/1Budget:batchUpdate') {
		return Response.json({replies: [{}]});
	}
	return notFound();
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const headers = new Headers(init?.headers);
	const body = init?.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.from(typeof init?.body === 'string' ? init.body : '');
	const request = {method: init?.method ?? 'GET', url, type: headers.get('content-type') ?? '', body: body.toString('utf8'), bytes: body};
	google.requests.push(request);
	return answer(request);
}) as typeof fetch);

// The writes made: every request but a GET.
function writes(): Request[] {
	return google.requests.filter((request) => request.method !== 'GET');
}

beforeEach(() => {
	state = fresh();
	history.logged = [];
	history.down = false;
	logError.mockClear();
	google.requests = [];
	google.appendColumn = 'A';
	google.appendedTitle = 'Q1';
	google.found = null;
});

describe('creating files', () => {
	test('a folder is made inside the folder given, in shared drives too, and answered as opening it would', async () => {
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.create(target, {name: 'Receipts', kind: 'Folder', content: ''}, '1Projects')).unwrap();

		const [made] = writes();
		expect(made?.url.pathname).toBe('/drive/v3/files');
		expect(made?.url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(JSON.parse(made?.body ?? '')).toEqual({name: 'Receipts', mimeType: MIME.folder, parents: ['1Projects']});
		expect(record).toMatchObject({id: '1New1', values: {name: 'Receipts', kind: 'Folder', content: ''}, hasChildren: true});
	});

	test('without a parent, or in My Drive, a file goes at the top of My Drive', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.create(target, {name: 'Inbox', kind: 'Folder'}, null);
		await filesConnector.create(target, {name: 'Inbox 2', kind: 'Folder'}, 'root');

		expect(writes().map((request) => JSON.parse(request.body).parents)).toEqual([['root'], ['root']]);
	});

	test('a document is uploaded as Markdown and a spreadsheet as CSV, each with the Google type Drive converts it to', async () => {
		const {filesConnector} = await import('./google-files');
		const doc = (await filesConnector.create(target, {name: 'Notes', kind: 'Document', content: '# Notes\n\nIt’s a start.'}, '1Projects')).unwrap();
		await filesConnector.create(target, {name: 'Costs', kind: 'Spreadsheet', content: 'Item,Amount\nRent,"1,200"'}, 'drive-0ATeamDrive');

		const [docUpload, sheetUpload] = writes();
		expect(docUpload?.url.pathname).toBe('/upload/drive/v3/files');
		expect(Object.fromEntries(docUpload?.url.searchParams ?? [])).toMatchObject({uploadType: 'multipart', supportsAllDrives: 'true'});
		expect(docUpload?.type).toMatch(/^multipart\/related; boundary=/);
		expect(multipartOf(docUpload as Request)).toEqual({
			metadata: {name: 'Notes', mimeType: MIME.document, parents: ['1Projects']},
			type: 'text/markdown; charset=UTF-8',
			content: '# Notes\n\nIt’s a start.',
		});
		expect(multipartOf(sheetUpload as Request)).toEqual({
			metadata: {name: 'Costs', mimeType: MIME.spreadsheet, parents: ['0ATeamDrive']},
			type: 'text/csv; charset=UTF-8',
			content: 'Item,Amount\nRent,"1,200"',
		});
		expect(doc.values).toMatchObject({name: 'Notes', kind: 'Document', content: '# Notes\n\nIt’s a start.'});
	});

	test('an empty document is made without an upload', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.create(target, {name: 'Blank', kind: 'Document', content: ''}, '1Projects');

		expect(writes().map((request) => [request.url.pathname, JSON.parse(request.body).mimeType])).toEqual([['/drive/v3/files', MIME.document]]);
	});

	test('a row goes at the end of a tab, its lines under the headers they name, and opens as a row', async () => {
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.create(target, {name: '', kind: '', content: 'Status: Due\nItem: Travel'}, 'sheet-1Budget-0')).unwrap();

		const [append] = writes();
		expect(decodeURIComponent(append?.url.pathname ?? '')).toBe("/v4/spreadsheets/1Budget/values/'Q1':append");
		expect(Object.fromEntries(append?.url.searchParams ?? [])).toEqual({valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS'});
		expect(JSON.parse(append?.body ?? '')).toEqual({majorDimension: 'ROWS', values: [['Travel', '', 'Due']]});
		expect(record).toMatchObject({id: 'row-1Budget-0-4', values: {name: 'Travel', kind: 'Row', content: 'Item: Travel\nStatus: Due'}});
	});

	test('a row Sheets appends past column A, under the last block of rows, is written again from A', async () => {
		google.appendColumn = 'B';
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.create(target, {content: 'Item: Travel\nStatus: Due'}, 'sheet-1Budget-0')).unwrap();

		const [, rewrite] = writes();
		expect(rewrite?.method).toBe('PUT');
		expect(JSON.parse(rewrite?.body ?? '')).toEqual({range: "'Q1'!A4:D4", majorDimension: 'ROWS', values: [['Travel', '', 'Due', '']]});
		expect(record).toMatchObject({id: 'row-1Budget-0-4', values: {content: 'Item: Travel\nStatus: Due'}});
	});

	test("the new row's number is read after the tab's title, whatever the title holds", async () => {
		google.appendedTitle = "'a!B7'";
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.create(target, {content: 'Item: Travel'}, 'sheet-1Budget-0')).unwrap();

		expect(record.id).toBe('row-1Budget-0-4');
	});

	test('a header repeated is told apart by its column, and a row written back changes the cell it names', async () => {
		state.grid = [
			['Item', 'Status', 'Status'],
			['Rent', 'Open', 'Closed'],
		];
		const {filesConnector} = await import('./google-files');
		const row = (await filesConnector.get(target, 'row-1Budget-0-2')).unwrap();
		expect(row.values.content).toBe('Item: Rent\nStatus: Open\nStatus (C): Closed');

		await filesConnector.update(target, 'row-1Budget-0-2', {content: 'Item: Rent\nStatus: Open\nStatus (C): Done'});
		expect(JSON.parse(writes()[0]?.body ?? '').data).toEqual([{range: "'Q1'!C2", majorDimension: 'ROWS', values: [['Done']]}]);
	});

	test('a row given a name is turned down, since its name is its first value', async () => {
		const {filesConnector} = await import('./google-files');
		const result = await filesConnector.create(target, {name: 'Travel', content: 'Status: Due'}, 'sheet-1Budget-0');

		expect(messageOf(result)).toBe('A row’s name is its first value: write it in content');
		expect(writes()).toEqual([]);
	});

	test('a row naming a header the tab lacks is turned down before anything is written', async () => {
		const {filesConnector} = await import('./google-files');
		const result = await filesConnector.create(target, {content: 'Colour: red'}, 'sheet-1Budget-0');

		expect(messageOf(result)).toStartWith('“Colour: red” doesn’t start with one of the names: Item, Amount, Status');
		expect(writes()).toEqual([]);
	});

	test('nothing is made in the places without a folder of their own, in a spreadsheet, or in a file', async () => {
		const {filesConnector} = await import('./google-files');
		const folder = {name: 'New', kind: 'Folder', content: ''};
		const refusals = await Promise.all([
			filesConnector.create(target, folder, 'recent'),
			filesConnector.create(target, folder, 'shared-with-me'),
			filesConnector.create(target, folder, 'shared-drives'),
			filesConnector.create(target, folder, '1Budget'),
			filesConnector.create(target, folder, '1Plan'),
			filesConnector.create(target, {name: 'New', kind: 'Presentation', content: ''}, '1Projects'),
			filesConnector.create(target, {name: '', kind: 'Document', content: ''}, '1Projects'),
			filesConnector.create(target, {name: 'New', kind: 'Folder', content: 'Something'}, '1Projects'),
		]);

		expect(refusals.map((result) => messageOf(result))).toEqual([
			'Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
			'Nothing can be made in Shared with me: make it in a folder, My Drive or a shared drive',
			'Nothing can be made in Shared drives: make it in a folder, My Drive or a shared drive',
			'Rows go in one of the spreadsheet’s tabs: open it and pick one as parent',
			'A document holds nothing: make it in a folder',
			'Say what to make as kind: Folder, Document, Spreadsheet or File',
			'A new document needs a name',
			'A folder has no content',
		]);
		expect(writes()).toEqual([]);
	});
});

// Bytes no text is: a PDF's start, a NUL, bytes past ASCII and a line break Drive must keep as they are.
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80, 0x0d, 0x0a, 0xe2]);

describe('uploading files', () => {
	test('a file is uploaded as its bytes are, of the type its name says, never converted, and opens as a file', async () => {
		const {filesConnector} = await import('./google-files');
		const base64 = BYTES.toString('base64');
		// Line breaks, as some encoders wrap base64, are left out.
		const record = (await filesConnector.create(target, {name: 'Results.pdf', kind: 'File', content: `${base64.slice(0, 8)}\n${base64.slice(8)}`}, 'drive-0ATeamDrive')).unwrap();

		const [upload] = writes();
		expect([upload?.method, upload?.url.pathname]).toEqual(['POST', '/upload/drive/v3/files']);
		expect(Object.fromEntries(upload?.url.searchParams ?? [])).toMatchObject({uploadType: 'multipart', supportsAllDrives: 'true'});
		expect(upload?.type).toMatch(/^multipart\/related; boundary=/);
		expect(uploadOf(upload as Request)).toEqual({metadata: {name: 'Results.pdf', mimeType: 'application/pdf', parents: ['0ATeamDrive']}, type: 'application/pdf', bytes: BYTES});
		expect(writes()).toHaveLength(1);
		expect(record).toMatchObject({id: '1New1', values: {name: 'Results.pdf', kind: 'File', content: ''}});
		expect(record.hasChildren).toBeUndefined();
	});

	test('a data URL says the type of a file whose name doesn’t, a name’s extension winning; with neither, it is bytes', async () => {
		const {filesConnector} = await import('./google-files');
		const base64 = BYTES.toString('base64');
		await filesConnector.create(target, {name: 'Scan 12', kind: 'File', content: `data:Image/PNG;base64,${base64}`}, '1Projects');
		await filesConnector.create(target, {name: 'chart.png', kind: 'File', content: `data:application/pdf;name=x.pdf;base64,${base64}`}, 'root');
		await filesConnector.create(target, {name: 'export', kind: 'File', content: base64}, '1Projects');

		const uploads = writes().map((request) => uploadOf(request));
		expect(uploads.map(({metadata}) => metadata)).toEqual([
			{name: 'Scan 12', mimeType: 'image/png', parents: ['1Projects']},
			{name: 'chart.png', mimeType: 'image/png', parents: ['root']},
			{name: 'export', mimeType: 'application/octet-stream', parents: ['1Projects']},
		]);
		expect(uploads.every(({bytes}) => bytes.equals(BYTES))).toBe(true);
	});

	test('content that isn’t base64, none, too much, a name, type or place a file can’t have are turned down before anything is written', async () => {
		const {filesConnector} = await import('./google-files');
		const content = BYTES.toString('base64');
		const refusals = await Promise.all([
			filesConnector.create(target, {name: 'notes.txt', kind: 'File', content: 'Just some text.'}, '1Projects'),
			filesConnector.create(target, {name: 'notes.txt', kind: 'File', content: 'abc'}, '1Projects'),
			filesConnector.create(target, {name: 'notes.txt', kind: 'File', content: 'Zm9v-_8='}, '1Projects'),
			filesConnector.create(target, {name: 'notes.txt', kind: 'File', content: ' \n'}, '1Projects'),
			filesConnector.create(target, {name: 'notes.txt', kind: 'File', content: 'data:text/plain;base64,'}, '1Projects'),
			filesConnector.create(target, {name: 'big.bin', kind: 'File', content: Buffer.alloc(6 * 1024 * 1024).toString('base64')}, '1Projects'),
			filesConnector.create(target, {name: ' ', kind: 'File', content}, '1Projects'),
			filesConnector.create(target, {name: 'Plan', kind: 'File', content: `data:application/vnd.google-apps.document;base64,${content}`}, '1Projects'),
			filesConnector.create(target, {name: 'Paper', kind: 'File', content: `data:pdf;base64,${content}`}, '1Projects'),
			filesConnector.create(target, {name: 'paper.pdf', kind: 'File', content}, 'recent'),
			filesConnector.create(target, {name: 'paper.pdf', kind: 'File', content}, '1Plan'),
			filesConnector.create(target, {name: 'paper.pdf', kind: 'File', content}, 'sheet-1Budget-0'),
		]);

		expect(refusals.map((result) => messageOf(result))).toEqual([
			'A file’s content is its bytes as base64, padded with =, as btoa writes it, or a data URL of them',
			'A file’s content is its bytes as base64, padded with =, as btoa writes it, or a data URL of them',
			'A file’s content is its bytes as base64, padded with =, as btoa writes it, or a data URL of them',
			'A new file needs its bytes in content, as base64',
			'A new file needs its bytes in content, as base64',
			'“big.bin” is too large to upload, at 6.0 MB: at most 5.0 MB',
			'A new file needs a name, with its extension, such as report.pdf',
			'A file uploaded keeps its own type: make a Document or a Spreadsheet to have Google’s',
			'A data URL’s type is a media type, such as application/pdf, not “pdf”',
			'Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
			'A document holds nothing: make it in a folder',
			'A tab holds rows: leave kind out, or make it Row',
		]);
		expect(writes()).toEqual([]);
	});

	test('a file uploaded is renamed as any file is, and its bytes aren’t written over', async () => {
		const {filesConnector} = await import('./google-files');
		const before = (await filesConnector.get(target, '1Paper')).unwrap();
		expect(before.values).toMatchObject({name: 'Paper.pdf', kind: 'File', content: ''});
		await filesConnector.update(target, '1Paper', {...before.values, name: 'Paper v2.pdf'}, before);
		expect(writes().map((request) => [request.method, request.url.pathname, JSON.parse(request.body)])).toEqual([['PATCH', '/drive/v3/files/1Paper', {name: 'Paper v2.pdf'}]]);

		google.requests = [];
		const refused = await filesConnector.update(target, '1Paper', {content: BYTES.toString('base64')});
		expect(messageOf(refused)).toBe('Only a document’s content can be written here; this file’s name can be changed');
		expect(writes()).toEqual([]);
	});
});

describe('copying files', () => {
	const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};

	function run(params: Record<string, unknown>) {
		return {caller: {agent, via: 'mcp' as const, taskId: 'task-1'}, connection: target.connection, params};
	}

	test('Drive copies a file into the folder given, under its own name where none is written, and the answer says the copy’s id and link', async () => {
		const {runFilesCopy} = await import('./google-files');
		const answer = (await runFilesCopy(run({id: '1Paper', parent: 'drive-0ATeamDrive'}))).unwrap();

		const [copy] = writes();
		expect([copy?.method, copy?.url.pathname, copy?.url.searchParams.get('supportsAllDrives'), JSON.parse(copy?.body ?? '')]).toEqual([
			'POST',
			'/drive/v3/files/1Paper/copy',
			'true',
			{name: 'Paper.pdf', parents: ['0ATeamDrive']},
		]);
		expect(writes()).toHaveLength(1);
		expect(answer).toBe(['Made “Paper.pdf”, a copy of “Paper.pdf”.', 'Id: 1New1', 'Kind: File', 'Link: https://drive.google.com/open?id=1New1'].join('\n'));
	});

	test('a file named by its link is copied under the name written, into My Drive where no folder is given', async () => {
		const {runFilesCopy} = await import('./google-files');
		const answer = (await runFilesCopy(run({id: 'https://docs.google.com/document/d/1Plan/edit', name: 'Plan for the board'}))).unwrap();

		expect(JSON.parse(writes()[0]?.body ?? '')).toEqual({name: 'Plan for the board', parents: ['root']});
		expect(answer).toStartWith('Made “Plan for the board”, a copy of “Launch plan”.\nId: 1New1\nKind: Document');
	});

	test('a folder, a file that isn’t there, a place, file or tab that holds no files, and params that aren’t text are turned down before anything is written', async () => {
		const {runFilesCopy} = await import('./google-files');
		const refusals = await Promise.all([
			runFilesCopy(run({id: '1Projects', parent: 'root'})),
			runFilesCopy(run({id: '1Gone'})),
			runFilesCopy(run({id: 'https://example.com/d/1Plan'})),
			runFilesCopy(run({id: '1Paper', parent: 'shared-with-me'})),
			runFilesCopy(run({id: '1Paper', parent: '1Plan'})),
			runFilesCopy(run({id: '1Paper', parent: '1Budget'})),
			runFilesCopy(run({id: '1Paper', parent: 'sheet-1Budget-0'})),
			runFilesCopy(run({id: '1Paper', parent: '1Missing'})),
			runFilesCopy(run({id: ['1Paper']})),
			runFilesCopy(run({id: '1Paper', folder: '1Projects'})),
		]);

		expect(refusals.map((result) => messageOf(result))).toEqual([
			'A folder can’t be copied: make a folder, and copy its files into it',
			'There is no file 1Gone to copy, or this account can’t open it',
			'Say which file to copy as id: its id, as files_list gives it, or its link',
			'Nothing can be made in Shared with me: make it in a folder, My Drive or a shared drive',
			'A document holds nothing: make it in a folder',
			'A spreadsheet holds tabs: copy the file into a folder',
			'A tab holds rows: make files in a folder',
			'not_found',
			'files_copy takes id, and parent and name where wanted, each as text',
			'files_copy takes id, and parent and name where wanted, each as text',
		]);
		expect(writes()).toEqual([]);
	});
});

describe('editing files', () => {
	test('a file is renamed with its metadata alone', async () => {
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.update(target, '1Deck', {name: 'Board deck v2', kind: 'Presentation', content: 'Slide one'})).unwrap();

		const [rename] = writes();
		expect([rename?.method, rename?.url.pathname, JSON.parse(rename?.body ?? '')]).toEqual(['PATCH', '/drive/v3/files/1Deck', {name: 'Board deck v2'}]);
		expect(rename?.url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(writes()).toHaveLength(1);
		expect(record.values.name).toBe('Board deck v2');
	});

	test('a document’s content is replaced whole by uploading Markdown, and only when written differently', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.update(target, '1Plan', {name: 'Launch plan', content: '# Launch plan\n\n- Ship it'});
		expect(writes()).toEqual([]);

		const record = (await filesConnector.update(target, '1Plan', {name: 'Launch plan', content: '# Launch plan\n\n- Shipped'})).unwrap();

		const [upload] = writes();
		expect([upload?.method, upload?.url.pathname, upload?.url.searchParams.get('uploadType'), upload?.type, upload?.body]).toEqual([
			'PATCH',
			'/upload/drive/v3/files/1Plan',
			'media',
			'text/markdown; charset=UTF-8',
			'# Launch plan\n\n- Shipped',
		]);
		expect(record.values.content).toBe('# Launch plan\n\n- Shipped');
	});

	test('a presentation’s or a spreadsheet’s content, a kind or an empty name is turned down before anything is written', async () => {
		const {filesConnector} = await import('./google-files');
		const refusals = await Promise.all([
			filesConnector.update(target, '1Deck', {name: 'Board deck v2', content: 'Slide two'}),
			filesConnector.update(target, '1Budget', {content: 'Q1: 3 rows'}),
			filesConnector.update(target, '1Plan', {kind: 'Spreadsheet'}),
			filesConnector.update(target, '1Plan', {name: ' '}),
			filesConnector.update(target, 'root', {name: 'Mine'}),
		]);

		expect(refusals.map((result) => messageOf(result))).toEqual([
			'A presentation’s content is only read here; its name can be changed',
			'A spreadsheet’s content is in its tabs: change its rows, or write a range',
			'What a file is can’t be changed: this is a Document',
			'A file needs a name',
			'The places at the top and shared drives aren’t changed here, only what is in them',
		]);
		expect(writes()).toEqual([]);
	});

	test('a rename leaves the content alone when it is as it read, however it reads now', async () => {
		const {filesConnector} = await import('./google-files');
		const before = (await filesConnector.get(target, '1Plan')).unwrap();
		const plan = state.files['1Plan'];
		if (plan) {
			plan.content = '# Launch plan\n\n- Shipped, by someone else meanwhile';
		}
		google.requests = [];
		await filesConnector.update(target, '1Plan', {...before.values, name: 'Plan'}, before);

		expect(writes().map((request) => [request.method, request.url.pathname])).toEqual([['PATCH', '/drive/v3/files/1Plan']]);
		expect(state.files['1Plan']?.content).toBe('# Launch plan\n\n- Shipped, by someone else meanwhile');
	});

	test('a row changes only in the cells written differently, a cell written empty cleared', async () => {
		const {filesConnector} = await import('./google-files');
		const record = (await filesConnector.update(target, 'row-1Budget-0-3', {name: 'Food', kind: 'Row', content: 'Item: Food\nAmount: 350\nStatus: Paid'})).unwrap();

		const [update] = writes();
		expect(update?.url.pathname).toBe('/v4/spreadsheets/1Budget/values:batchUpdate');
		expect(JSON.parse(update?.body ?? '')).toEqual({
			valueInputOption: 'USER_ENTERED',
			data: [
				{range: "'Q1'!B3", majorDimension: 'ROWS', values: [['350']]},
				{range: "'Q1'!C3", majorDimension: 'ROWS', values: [['Paid']]},
			],
		});
		expect(record.values.content).toBe('Item: Food\nAmount: 350\nStatus: Paid');

		await filesConnector.update(target, 'row-1Budget-0-2', {content: 'Status:'});
		expect(JSON.parse(writes()[1]?.body ?? '').data).toEqual([{range: "'Q1'!C2", majorDimension: 'ROWS', values: [['']]}]);
	});

	test('a row written as it reads changes nothing, and its name is its first value', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.update(target, 'row-1Budget-0-2', {name: 'Rent', content: 'Item: Rent\nAmount: 1,200\nStatus: Paid'});
		const renamed = await filesConnector.update(target, 'row-1Budget-0-2', {name: 'Mortgage'});

		expect(messageOf(renamed)).toBe('A row’s name is its first value: change it in content');
		expect(writes()).toEqual([]);
	});

	test('a tab is renamed through the spreadsheet', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.update(target, 'sheet-1Budget-0', {name: 'Q1 2026', content: '100 rows, 3 columns'});

		const [rename] = writes();
		expect(rename?.url.pathname).toBe('/v4/spreadsheets/1Budget:batchUpdate');
		expect(JSON.parse(rename?.body ?? '')).toEqual({requests: [{updateSheetProperties: {properties: {sheetId: 0, title: 'Q1 2026'}, fields: 'title'}}]});
	});
});

describe('moving files to Trash', () => {
	test('a file goes to Trash, never deleted, and leaves the tree', async () => {
		const {filesConnector} = await import('./google-files');
		const result = await filesConnector.commands?.trash?.({...target}, '1Plan');

		expect(result?.unwrap()).toBeNull();
		expect(writes().map((request) => [request.method, request.url.pathname, JSON.parse(request.body)])).toEqual([['PATCH', '/drive/v3/files/1Plan', {trashed: true}]]);
	});

	test('places, tabs and rows are not files to trash', async () => {
		const {filesConnector} = await import('./google-files');
		const tab = await filesConnector.commands?.trash?.(target, 'sheet-1Budget-0');

		expect(tab?.isErr() && tab.error.kind).toBe('validation_error');
		expect(writes()).toEqual([]);
	});

	test('a file that is gone is not found by its id', async () => {
		const {filesConnector} = await import('./google-files');
		const result = await filesConnector.commands?.trash?.(target, '1Gone');

		expect(result?.isErr() && result.error).toMatchObject({kind: 'not_found', id: '1Gone'});
	});
});

describe('finding files for the widget', () => {
	test("in Drive's query language: every word in the name, or in the text, the owner, never what is trashed, quotes escaped", async () => {
		const {driveQuery} = await import('./google-files');
		const search = {words: ['q3', "paul's"], owner: 'paul@example.com'};
		expect(driveQuery(search, 'name')).toBe("name contains 'q3' and name contains 'paul\\'s' and 'paul@example.com' in owners and trashed = false");
		expect(driveQuery(search, 'content')).toBe("fullText contains 'q3' and fullText contains 'paul\\'s' and 'paul@example.com' in owners and trashed = false");
		expect(driveQuery({words: [], owner: null}, 'name')).toBe('trashed = false');
	});

	test('by name, the most recently changed first, in every drive', async () => {
		google.found = (q) => (q.startsWith('name') ? [state.files['1Budget'], state.files['1Plan']].flatMap((file) => (file ? [file] : [])) : []);
		const {filesConnector} = await import('./google-files');
		const found = (await filesConnector.findFiles(target, {words: ['budget'], owner: null}, 8)).unwrap();

		expect(google.requests).toHaveLength(1);
		const params = google.requests[0]?.url.searchParams;
		expect(params?.get('q')).toBe("name contains 'budget' and trashed = false");
		expect(params?.get('orderBy')).toBe('modifiedTime desc');
		expect(params?.get('corpora')).toBe('allDrives');
		expect(params?.get('pageSize')).toBe('30');
		expect(found).toEqual([
			{id: '1Budget', name: 'Budget 2026', kind: 'Spreadsheet', owner: 'Alex Kim', modified: '2026-10-08T08:00:00.000Z', link: 'https://drive.google.com/open?id=1Budget', matched: 'name'},
			{id: '1Plan', name: 'Launch plan', kind: 'Document', owner: 'Alex Kim', modified: '2026-10-08T08:00:00.000Z', link: 'https://drive.google.com/open?id=1Plan', matched: 'name'},
		]);
	});

	test('inside the files where no name has the words, as many as asked for, in the order Drive finds best', async () => {
		google.found = (q) => (q.startsWith('fullText') ? [state.files['1Plan']].flatMap((file) => (file ? [file] : [])) : []);
		const {filesConnector} = await import('./google-files');
		const found = (await filesConnector.findFiles(target, {words: ['ship'], owner: null}, 8)).unwrap();

		const params = google.requests[1]?.url.searchParams;
		expect(params?.get('q')).toBe("fullText contains 'ship' and trashed = false");
		expect(params?.has('orderBy')).toBe(false);
		expect(params?.get('pageSize')).toBe('8');
		expect(found.map((file) => [file.name, file.matched])).toEqual([['Launch plan', 'content']]);
	});
});

describe('the history of what is written', () => {
	test('a file made, a copy too, is logged as made, with the revision Drive gives it', async () => {
		const {filesConnector, runFilesCopy} = await import('./google-files');
		await filesConnector.create(target, {name: 'Notes', kind: 'Document', content: '# Notes'}, '1Projects');
		const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
		await runFilesCopy({caller: {agent, via: 'mcp', taskId: 'task-1'}, connection: target.connection, params: {id: '1Plan'}});

		expect(history.logged.map(({kind, fileId, name, afterRevision}) => [kind, fileId, name, afterRevision])).toEqual([
			['create', '1New1', 'Notes', '1New1-r2'],
			['create', '1New2', 'Launch plan', '1New2-r3'],
		]);
	});

	test('a rename is logged as a move from the old name, and a document written over with the revisions around it', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.update(target, '1Plan', {name: 'Launch plan v2', content: '# Launch plan\n\n- Ship it twice'});

		expect(history.logged).toEqual([
			expect.objectContaining({kind: 'move', fileId: '1Plan', name: 'Launch plan v2', beforeName: 'Launch plan', beforeRevision: '1Plan-r1', afterRevision: '1Plan-r2'}),
			expect.objectContaining({kind: 'write', fileId: '1Plan', name: 'Launch plan v2', beforeRevision: '1Plan-r2', afterRevision: '1Plan-r3', undo: null}),
		]);
	});

	test('a row changed keeps its cells from the first changed to the last as they were and are, for an exact undo', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.update(target, 'row-1Budget-0-3', {content: 'Item: Food\nAmount: 350\nStatus: Paid'});

		const [edit] = history.logged;
		expect(edit).toMatchObject({kind: 'edit', fileId: '1Budget', name: 'Budget 2026'});
		expect(edit?.undo).toEqual({
			kind: 'sheets_cells',
			sheetId: 0,
			tab: 'Q1',
			range: 'B3:C3',
			before: [[{value: '300'}, null]],
			after: [[{value: '350'}, {value: 'Paid'}]],
		});
	});

	test('a row added keeps its cells as empty before, and a tab renamed is an edit of the spreadsheet', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.create(target, {content: 'Item: Travel\nStatus: Due'}, 'sheet-1Budget-0');
		await filesConnector.update(target, 'sheet-1Budget-0', {name: 'Q1 2026'});

		expect(history.logged.map(({kind, fileId, undo}) => [kind, fileId, undo])).toEqual([
			['edit', '1Budget', {kind: 'sheets_cells', sheetId: 0, tab: 'Q1', range: 'A4:C4', before: [[null, null, null]], after: [[{value: 'Travel'}, null, {value: 'Due'}]]}],
			['edit', '1Budget', null],
		]);
	});

	test('a file moved to Trash is logged as trashed', async () => {
		const {filesConnector} = await import('./google-files');
		await filesConnector.commands?.trash?.(target, '1Paper');

		expect(history.logged.map(({kind, fileId}) => [kind, fileId])).toEqual([['trash', '1Paper']]);
	});

	test('a write Drive made is answered as made even where logging it fails, which the server logs by its ids alone', async () => {
		history.down = true;
		const {filesConnector} = await import('./google-files');
		const row = await filesConnector.create(target, {content: 'Item: Travel\nStatus: Due'}, 'sheet-1Budget-0');
		const folder = await filesConnector.create(target, {name: 'Receipts', kind: 'Folder'}, '1Projects');

		expect(row.isOk() && row.value.id).toBe('row-1Budget-0-4');
		expect(folder.isOk() && folder.value.values.name).toBe('Receipts');
		expect(writes().filter((request) => request.method === 'POST')).toHaveLength(2);
		expect(logError.mock.calls).toEqual([
			['A change made in Google Drive could not be logged in its history', {connectionId: 'google-1', fileId: '1Budget', kind: 'edit', errorKind: 'db_error'}],
			['A change made in Google Drive could not be logged in its history', {connectionId: 'google-1', fileId: '1New1', kind: 'create', errorKind: 'db_error'}],
		]);
	});

	test('a write with no one to log it as never reaches Drive', async () => {
		const {filesConnector} = await import('./google-files');
		const {by: _by, ...unknown} = target;
		const result = await filesConnector.update(unknown, '1Plan', {name: 'Nobody’s plan'});

		expect(result.isErr() && result.error.kind).toBe('internal_error');
		expect(writes()).toEqual([]);
		expect(history.logged).toEqual([]);
	});
});
