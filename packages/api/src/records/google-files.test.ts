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
		connectedById: 'user-1',
		account: 'alex@example.com',
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credential: `enc:${JSON.stringify(CREDENTIAL)}`,
	},
	collection: files(),
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

type Request = {method: string; url: URL; type: string; body: string};

// Where Sheets puts an appended row: after the last rows holding anything, from the first column of
// the block they are in.
const google = {requests: [] as Request[], appendColumn: 'A', appendedTitle: 'Q1'};

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

// The metadata and the content of a multipart upload.
function multipartOf(request: Request): {metadata: {name: string; mimeType: string; parents: string[]}; type: string; content: string} {
	const boundary = /boundary=(.+)$/.exec(request.type)?.[1] ?? '';
	const [, first = '', second = ''] = request.body.split(`--${boundary}`);
	const [, json = '{}'] = first.split('\r\n\r\n');
	const [head = '', ...content] = second.split('\r\n\r\n');
	return {metadata: JSON.parse(json.trim()), type: head.replace('\r\nContent-Type: ', ''), content: content.join('\r\n\r\n').replace(/\r\n$/, '')};
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
	const request = {method: init?.method ?? 'GET', url, type: headers.get('content-type') ?? '', body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	return answer(request);
}) as typeof fetch);

// The writes made: every request but a GET.
function writes(): Request[] {
	return google.requests.filter((request) => request.method !== 'GET');
}

beforeEach(() => {
	state = fresh();
	google.requests = [];
	google.appendColumn = 'A';
	google.appendedTitle = 'Q1';
});

describe('creating files', () => {
	test('a folder is made inside the folder given, in shared drives too, and answered as opening it would', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {name: 'Receipts', kind: 'Folder', content: ''}, '1Projects')).unwrap();

		const [made] = writes();
		expect(made?.url.pathname).toBe('/drive/v3/files');
		expect(made?.url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(JSON.parse(made?.body ?? '')).toEqual({name: 'Receipts', mimeType: MIME.folder, parents: ['1Projects']});
		expect(record).toMatchObject({id: '1New1', values: {name: 'Receipts', kind: 'Folder', content: ''}, hasChildren: true});
	});

	test('without a parent, or in My Drive, a file goes at the top of My Drive', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.create(target, {name: 'Inbox', kind: 'Folder'}, null);
		await googleConnector.create(target, {name: 'Inbox 2', kind: 'Folder'}, 'root');

		expect(writes().map((request) => JSON.parse(request.body).parents)).toEqual([['root'], ['root']]);
	});

	test('a document is uploaded as Markdown and a spreadsheet as CSV, each with the Google type Drive converts it to', async () => {
		const {googleConnector} = await import('./google-connector');
		const doc = (await googleConnector.create(target, {name: 'Notes', kind: 'Document', content: '# Notes\n\nIt’s a start.'}, '1Projects')).unwrap();
		await googleConnector.create(target, {name: 'Costs', kind: 'Spreadsheet', content: 'Item,Amount\nRent,"1,200"'}, 'drive-0ATeamDrive');

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
		const {googleConnector} = await import('./google-connector');
		await googleConnector.create(target, {name: 'Blank', kind: 'Document', content: ''}, '1Projects');

		expect(writes().map((request) => [request.url.pathname, JSON.parse(request.body).mimeType])).toEqual([['/drive/v3/files', MIME.document]]);
	});

	test('a row goes at the end of a tab, its lines under the headers they name, and opens as a row', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {name: '', kind: '', content: 'Status: Due\nItem: Travel'}, 'sheet-1Budget-0')).unwrap();

		const [append] = writes();
		expect(decodeURIComponent(append?.url.pathname ?? '')).toBe("/v4/spreadsheets/1Budget/values/'Q1':append");
		expect(Object.fromEntries(append?.url.searchParams ?? [])).toEqual({valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS'});
		expect(JSON.parse(append?.body ?? '')).toEqual({majorDimension: 'ROWS', values: [['Travel', '', 'Due']]});
		expect(record).toMatchObject({id: 'row-1Budget-0-4', values: {name: 'Travel', kind: 'Row', content: 'Item: Travel\nStatus: Due'}});
	});

	test('a row Sheets appends past column A, under the last block of rows, is written again from A', async () => {
		google.appendColumn = 'B';
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {content: 'Item: Travel\nStatus: Due'}, 'sheet-1Budget-0')).unwrap();

		const [, rewrite] = writes();
		expect(rewrite?.method).toBe('PUT');
		expect(JSON.parse(rewrite?.body ?? '')).toEqual({range: "'Q1'!A4:D4", majorDimension: 'ROWS', values: [['Travel', '', 'Due', '']]});
		expect(record).toMatchObject({id: 'row-1Budget-0-4', values: {content: 'Item: Travel\nStatus: Due'}});
	});

	test("the new row's number is read after the tab's title, whatever the title holds", async () => {
		google.appendedTitle = "'a!B7'";
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {content: 'Item: Travel'}, 'sheet-1Budget-0')).unwrap();

		expect(record.id).toBe('row-1Budget-0-4');
	});

	test('a header repeated is told apart by its column, and a row written back changes the cell it names', async () => {
		state.grid = [
			['Item', 'Status', 'Status'],
			['Rent', 'Open', 'Closed'],
		];
		const {googleConnector} = await import('./google-connector');
		const row = (await googleConnector.get(target, 'row-1Budget-0-2')).unwrap();
		expect(row.values.content).toBe('Item: Rent\nStatus: Open\nStatus (C): Closed');

		await googleConnector.update(target, 'row-1Budget-0-2', {content: 'Item: Rent\nStatus: Open\nStatus (C): Done'});
		expect(JSON.parse(writes()[0]?.body ?? '').data).toEqual([{range: "'Q1'!C2", majorDimension: 'ROWS', values: [['Done']]}]);
	});

	test('a row given a name is turned down, since its name is its first value', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.create(target, {name: 'Travel', content: 'Status: Due'}, 'sheet-1Budget-0');

		expect(messageOf(result)).toBe('A row’s name is its first value: write it in content');
		expect(writes()).toEqual([]);
	});

	test('a row naming a header the tab lacks is turned down before anything is written', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.create(target, {content: 'Colour: red'}, 'sheet-1Budget-0');

		expect(messageOf(result)).toStartWith('“Colour: red” doesn’t start with one of the names: Item, Amount, Status');
		expect(writes()).toEqual([]);
	});

	test('nothing is made in the places without a folder of their own, in a spreadsheet, or in a file', async () => {
		const {googleConnector} = await import('./google-connector');
		const folder = {name: 'New', kind: 'Folder', content: ''};
		const refusals = await Promise.all([
			googleConnector.create(target, folder, 'recent'),
			googleConnector.create(target, folder, 'shared-with-me'),
			googleConnector.create(target, folder, 'shared-drives'),
			googleConnector.create(target, folder, '1Budget'),
			googleConnector.create(target, folder, '1Plan'),
			googleConnector.create(target, {name: 'New', kind: 'Presentation', content: ''}, '1Projects'),
			googleConnector.create(target, {name: '', kind: 'Document', content: ''}, '1Projects'),
			googleConnector.create(target, {name: 'New', kind: 'Folder', content: 'Something'}, '1Projects'),
		]);

		expect(refusals.map((result) => messageOf(result))).toEqual([
			'Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
			'Nothing can be made in Shared with me: make it in a folder, My Drive or a shared drive',
			'Nothing can be made in Shared drives: make it in a folder, My Drive or a shared drive',
			'Rows go in one of the spreadsheet’s tabs: open it and pick one as parent',
			'A document holds nothing: make it in a folder',
			'Say what to make as kind: Folder, Document or Spreadsheet',
			'A new document needs a name',
			'A folder has no content',
		]);
		expect(writes()).toEqual([]);
	});
});

describe('editing files', () => {
	test('a file is renamed with its metadata alone', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.update(target, '1Deck', {name: 'Board deck v2', kind: 'Presentation', content: 'Slide one'})).unwrap();

		const [rename] = writes();
		expect([rename?.method, rename?.url.pathname, JSON.parse(rename?.body ?? '')]).toEqual(['PATCH', '/drive/v3/files/1Deck', {name: 'Board deck v2'}]);
		expect(rename?.url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(writes()).toHaveLength(1);
		expect(record.values.name).toBe('Board deck v2');
	});

	test('a document’s content is replaced whole by uploading Markdown, and only when written differently', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.update(target, '1Plan', {name: 'Launch plan', content: '# Launch plan\n\n- Ship it'});
		expect(writes()).toEqual([]);

		const record = (await googleConnector.update(target, '1Plan', {name: 'Launch plan', content: '# Launch plan\n\n- Shipped'})).unwrap();

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
		const {googleConnector} = await import('./google-connector');
		const refusals = await Promise.all([
			googleConnector.update(target, '1Deck', {name: 'Board deck v2', content: 'Slide two'}),
			googleConnector.update(target, '1Budget', {content: 'Q1: 3 rows'}),
			googleConnector.update(target, '1Plan', {kind: 'Spreadsheet'}),
			googleConnector.update(target, '1Plan', {name: ' '}),
			googleConnector.update(target, 'root', {name: 'Mine'}),
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
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, '1Plan')).unwrap();
		const plan = state.files['1Plan'];
		if (plan) {
			plan.content = '# Launch plan\n\n- Shipped, by someone else meanwhile';
		}
		google.requests = [];
		await googleConnector.update(target, '1Plan', {...before.values, name: 'Plan'}, before);

		expect(writes().map((request) => [request.method, request.url.pathname])).toEqual([['PATCH', '/drive/v3/files/1Plan']]);
		expect(state.files['1Plan']?.content).toBe('# Launch plan\n\n- Shipped, by someone else meanwhile');
	});

	test('a row changes only in the cells written differently, a cell written empty cleared', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.update(target, 'row-1Budget-0-3', {name: 'Food', kind: 'Row', content: 'Item: Food\nAmount: 350\nStatus: Paid'})).unwrap();

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

		await googleConnector.update(target, 'row-1Budget-0-2', {content: 'Status:'});
		expect(JSON.parse(writes()[1]?.body ?? '').data).toEqual([{range: "'Q1'!C2", majorDimension: 'ROWS', values: [['']]}]);
	});

	test('a row written as it reads changes nothing, and its name is its first value', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.update(target, 'row-1Budget-0-2', {name: 'Rent', content: 'Item: Rent\nAmount: 1,200\nStatus: Paid'});
		const renamed = await googleConnector.update(target, 'row-1Budget-0-2', {name: 'Mortgage'});

		expect(messageOf(renamed)).toBe('A row’s name is its first value: change it in content');
		expect(writes()).toEqual([]);
	});

	test('a tab is renamed through the spreadsheet', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.update(target, 'sheet-1Budget-0', {name: 'Q1 2026', content: '100 rows, 3 columns'});

		const [rename] = writes();
		expect(rename?.url.pathname).toBe('/v4/spreadsheets/1Budget:batchUpdate');
		expect(JSON.parse(rename?.body ?? '')).toEqual({requests: [{updateSheetProperties: {properties: {sheetId: 0, title: 'Q1 2026'}, fields: 'title'}}]});
	});
});

describe('moving files to Trash', () => {
	test('a file goes to Trash, never deleted, and leaves the tree', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.commands?.trash?.({...target}, '1Plan');

		expect(result?.unwrap()).toBeNull();
		expect(writes().map((request) => [request.method, request.url.pathname, JSON.parse(request.body)])).toEqual([['PATCH', '/drive/v3/files/1Plan', {trashed: true}]]);
	});

	test('places, tabs and rows are not files to trash, and deleting is refused', async () => {
		const {googleConnector} = await import('./google-connector');
		const tab = await googleConnector.commands?.trash?.(target, 'sheet-1Budget-0');
		const removed = await googleConnector.remove(target, '1Plan');

		expect(tab?.isErr() && tab.error.kind).toBe('validation_error');
		expect(messageOf(removed)).toBe('Files in Google Drive are moved to Trash, never deleted here');
		expect(writes()).toEqual([]);
	});

	test('a file that is gone is not found by its id', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.commands?.trash?.(target, '1Gone');

		expect(result?.isErr() && result.error).toMatchObject({kind: 'not_found', id: '1Gone'});
	});
});
