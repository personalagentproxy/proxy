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

const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});

// A Drive as Google answers it: My Drive holding Projects, which holds a plan, a budget and a deck.
const MY_DRIVE_ID = '0AFmyDriveRootUk9PVA';
const OWNER = [{displayName: 'Alex Kim', emailAddress: 'alex@example.com'}];

const DRIVE_FILES: Record<string, object> = {
	'1Projects': {
		id: '1Projects',
		name: 'Projects',
		mimeType: 'application/vnd.google-apps.folder',
		modifiedTime: '2026-10-01T09:00:00.000Z',
		owners: OWNER,
		webViewLink: 'https://drive.google.com/drive/folders/1Projects',
		parents: [MY_DRIVE_ID],
	},
	'1Plan': {
		id: '1Plan',
		name: 'Launch plan',
		mimeType: 'application/vnd.google-apps.document',
		modifiedTime: '2026-10-08T08:16:23.137Z',
		owners: OWNER,
		webViewLink: 'https://docs.google.com/document/d/1Plan/edit?usp=drivesdk',
		parents: ['1Projects'],
	},
	'1Budget': {
		id: '1Budget',
		name: 'Budget 2026',
		mimeType: 'application/vnd.google-apps.spreadsheet',
		modifiedTime: '2026-10-07T12:00:00.000Z',
		owners: OWNER,
		webViewLink: 'https://docs.google.com/spreadsheets/d/1Budget/edit?usp=drivesdk',
		parents: ['1Projects'],
	},
	'1Huge': {
		id: '1Huge',
		name: 'Everything ever written',
		mimeType: 'application/vnd.google-apps.document',
		modifiedTime: '2026-09-01T12:00:00.000Z',
		owners: OWNER,
		webViewLink: 'https://docs.google.com/document/d/1Huge/edit?usp=drivesdk',
		parents: [MY_DRIVE_ID],
	},
};

const SHEETS = {
	sheets: [
		{properties: {sheetId: 0, title: 'Q1', gridProperties: {rowCount: 120, columnCount: 8}}},
		{properties: {sheetId: 1834, title: "Alex's notes", gridProperties: {rowCount: 1000, columnCount: 26}}},
	],
};

// The rows of a tab as Google keeps them, by number; a row without any is empty.
function storedRow(row: number): string[] | null {
	if (row < 2 || row > 54) {
		return null;
	}
	return [`Item ${row}`, String(row * 10), row % 5 === 2 ? 'Paid' : ''];
}

// A range's rows as Sheets answers them: the empty ones at its end left out.
function rowsBetween(from: number, to: number): string[][] {
	const all = Array.from({length: to - from + 1}, (_, index) => drive.row(from + index));
	const last = all.findLastIndex((row) => row !== null);
	return all.slice(0, last + 1).map((row) => row ?? []);
}

function googleError(status: number, message: string, reason: string): Response {
	return Response.json({error: {code: status, message, errors: [{message, domain: 'global', reason}]}}, {status});
}

const drive = {requests: [] as URL[], answer: (_url: URL): Response | null => null, row: storedRow};

function answer(url: URL): Response {
	const custom = drive.answer(url);
	if (custom) {
		return custom;
	}
	const path = url.pathname;
	if (path === '/drive/v3/files/root') {
		return Response.json({id: MY_DRIVE_ID});
	}
	if (path === '/drive/v3/files') {
		return Response.json({nextPageToken: 'page-2', files: [DRIVE_FILES['1Projects'], DRIVE_FILES['1Plan']]});
	}
	if (path === '/drive/v3/files/1Plan/export') {
		return new Response('# Launch plan\n\n- Ship it', {headers: {'content-type': 'text/markdown'}});
	}
	if (path === '/drive/v3/files/1Huge/export') {
		return googleError(403, 'This file is too large to be exported.', 'exportSizeLimitExceeded');
	}
	const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
	if (file) {
		return DRIVE_FILES[file] ? Response.json(DRIVE_FILES[file]) : googleError(404, `File not found: ${file}.`, 'notFound');
	}
	if (path === '/v4/spreadsheets/1Budget') {
		return Response.json(SHEETS);
	}
	if (path === '/v4/spreadsheets/1Budget/values:batchGet') {
		const valueRanges = url.searchParams.getAll('ranges').map((range) => {
			const [, from = '1', to = '1'] = /!A(\d+):ZZ(\d+)$/.exec(range) ?? [];
			const values = from === '1' ? [['Item', 'Amount', '']] : rowsBetween(Number(from), Number(to));
			return {range, majorDimension: 'ROWS', ...(values.length > 0 ? {values} : {})};
		});
		return Response.json({spreadsheetId: '1Budget', valueRanges});
	}
	return googleError(404, 'Not found', 'notFound');
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	drive.requests.push(url);
	return answer(url);
}) as typeof fetch);

function requested(path: string): URL[] {
	return drive.requests.filter((url) => url.pathname === path);
}

beforeEach(() => {
	drive.requests = [];
	drive.answer = () => null;
	drive.row = storedRow;
});

describe('googleConnector.list', () => {
	test('the top is the four places, each holding files', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, query())).unwrap();

		expect(page).toEqual({
			records: [
				{id: 'root', values: {name: 'My Drive', kind: 'Place'}, updatedAt: '', url: 'https://drive.google.com/drive/my-drive', hasChildren: true},
				{id: 'shared-with-me', values: {name: 'Shared with me', kind: 'Place'}, updatedAt: '', url: 'https://drive.google.com/drive/shared-with-me', hasChildren: true},
				{id: 'shared-drives', values: {name: 'Shared drives', kind: 'Place'}, updatedAt: '', url: 'https://drive.google.com/drive/shared-drives', hasChildren: true},
				{id: 'recent', values: {name: 'Recent', kind: 'Place'}, updatedAt: '', url: 'https://drive.google.com/drive/recent', hasChildren: true},
			],
			nextPage: null,
		});
		expect(drive.requests).toEqual([]);
	});

	test('inside a folder, its files, folders first, from the page token given, with the next one and the trail', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, query({parent: '1Projects', page: 'page-1'}))).unwrap();

		const [list] = requested('/drive/v3/files');
		expect(Object.fromEntries(list?.searchParams ?? [])).toEqual({
			q: "'1Projects' in parents and trashed=false",
			orderBy: 'folder,modifiedTime desc',
			pageSize: '50',
			pageToken: 'page-1',
			fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,parents,driveId)',
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true',
		});
		expect(requested('/drive/v3/files/1Projects')[0]?.searchParams.get('supportsAllDrives')).toBe('true');
		expect(page.nextPage).toBe('page-2');
		expect(page.records).toEqual([
			{
				id: '1Projects',
				values: {name: 'Projects', kind: 'Folder', modified: '2026-10-01T09:00:00.000Z', owner: 'Alex Kim'},
				updatedAt: '2026-10-01T09:00:00.000Z',
				url: 'https://drive.google.com/drive/folders/1Projects',
				hasChildren: true,
			},
			{
				id: '1Plan',
				values: {name: 'Launch plan', kind: 'Document', modified: '2026-10-08T08:16:23.137Z', owner: 'Alex Kim'},
				updatedAt: '2026-10-08T08:16:23.137Z',
				url: 'https://docs.google.com/document/d/1Plan/edit?usp=drivesdk',
			},
		]);
		expect(page.trail).toEqual([
			{id: 'root', title: 'My Drive'},
			{id: '1Projects', title: 'Projects'},
		]);
	});

	test('My Drive lists what is at its top, Shared with me and Recent in their own order', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.list(target, query({parent: 'root'}));
		await googleConnector.list(target, query({parent: 'shared-with-me'}));
		const recent = (await googleConnector.list(target, query({parent: 'recent'}))).unwrap();

		expect(requested('/drive/v3/files').map((url) => [url.searchParams.get('q'), url.searchParams.get('orderBy')])).toEqual([
			["'root' in parents and trashed=false", 'folder,modifiedTime desc'],
			['sharedWithMe=true and trashed=false', 'sharedWithMeTime desc'],
			["viewedByMeTime > '1970-01-01T00:00:00' and mimeType != 'application/vnd.google-apps.folder' and trashed=false", 'viewedByMeTime desc'],
		]);
		expect(requested('/drive/v3/files')[2]?.searchParams.get('corpora')).toBe('allDrives');
		expect(recent.trail).toEqual([{id: 'recent', title: 'Recent'}]);
	});

	test('shared drives are listed as such, and inside one its own files', async () => {
		const {googleConnector} = await import('./google-connector');
		drive.answer = (url) => {
			if (url.pathname === '/drive/v3/drives') {
				return Response.json({drives: [{id: '0ATeamDrive', name: 'Team', kind: 'drive#drive'}]});
			}
			if (url.pathname === '/drive/v3/drives/0ATeamDrive') {
				return Response.json({id: '0ATeamDrive', name: 'Team'});
			}
			return null;
		};

		const drives = (await googleConnector.list(target, query({parent: 'shared-drives'}))).unwrap();
		const inside = (await googleConnector.list(target, query({parent: 'drive-0ATeamDrive'}))).unwrap();

		expect(drives.records).toEqual([
			{id: 'drive-0ATeamDrive', values: {name: 'Team', kind: 'Shared drive'}, updatedAt: '', url: 'https://drive.google.com/drive/folders/0ATeamDrive', hasChildren: true},
		]);
		const [list] = requested('/drive/v3/files');
		expect(list?.searchParams.get('q')).toBe("'0ATeamDrive' in parents and trashed=false");
		expect(list?.searchParams.get('corpora')).toBe('drive');
		expect(list?.searchParams.get('driveId')).toBe('0ATeamDrive');
		expect(inside.trail).toEqual([
			{id: 'shared-drives', title: 'Shared drives'},
			{id: 'drive-0ATeamDrive', title: 'Team'},
		]);
	});

	test('a search goes through all of Drive, its words quoted as Drive needs, in the order Drive finds best', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.list(target, query({search: "Alex's \\ plan"}));
		await googleConnector.list(target, query({search: 'plan', parent: '1Projects'}));

		const [everywhere, inFolder] = requested('/drive/v3/files');
		expect(everywhere?.searchParams.get('q')).toBe("fullText contains 'Alex\\'s \\\\ plan' and trashed=false");
		expect(everywhere?.searchParams.get('corpora')).toBe('allDrives');
		expect(everywhere?.searchParams.get('orderBy')).toBeNull();
		expect(inFolder?.searchParams.get('q')).toBe("fullText contains 'plan' and '1Projects' in parents and trashed=false");
	});

	test("an id that isn't one of Drive's never reaches Google", async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.list(target, query({parent: "x' or name contains '"}));

		expect(result.isErr() && result.error.kind).toBe('not_found');
		expect(drive.requests).toEqual([]);
	});

	test("a spreadsheet holds its tabs, and a tab its rows, 50 to a page under the first row's headers", async () => {
		const {googleConnector} = await import('./google-connector');
		const tabs = (await googleConnector.list(target, query({parent: '1Budget'}))).unwrap();

		expect(tabs.records.map((record) => [record.id, record.values.name, record.values.content, record.hasChildren, record.url])).toEqual([
			['sheet-1Budget-0', 'Q1', '120 rows, 8 columns', true, 'https://docs.google.com/spreadsheets/d/1Budget/edit?usp=drivesdk#gid=0'],
			['sheet-1Budget-1834', "Alex's notes", '1000 rows, 26 columns', true, 'https://docs.google.com/spreadsheets/d/1Budget/edit?usp=drivesdk#gid=1834'],
		]);
		expect(tabs.trail).toEqual([
			{id: 'root', title: 'My Drive'},
			{id: '1Projects', title: 'Projects'},
			{id: '1Budget', title: 'Budget 2026'},
		]);

		const first = (await googleConnector.list(target, query({parent: 'sheet-1Budget-1834'}))).unwrap();
		expect(requested('/v4/spreadsheets/1Budget/values:batchGet')[0]?.searchParams.getAll('ranges')).toEqual(["'Alex''s notes'!A1:ZZ1", "'Alex''s notes'!A2:ZZ51"]);
		expect(first.records).toHaveLength(50);
		expect(first.records[0]).toEqual({
			id: 'row-1Budget-1834-2',
			values: {
				name: 'Item 2',
				kind: 'Row',
				modified: '2026-10-07T12:00:00.000Z',
				owner: 'Alex Kim',
				content: 'Item: Item 2\nAmount: 20\nColumn C: Paid',
			},
			updatedAt: '2026-10-07T12:00:00.000Z',
			// The row itself, in its tab.
			url: 'https://docs.google.com/spreadsheets/d/1Budget/edit?usp=drivesdk#gid=1834&range=A2',
		});
		expect(first.nextPage).toBe('52');
		expect(first.trail?.at(-1)).toEqual({id: 'sheet-1Budget-1834', title: "Alex's notes"});

		const last = (await googleConnector.list(target, query({parent: 'sheet-1Budget-1834', page: '52'}))).unwrap();
		expect(last.records.map((record) => record.id)).toEqual(['row-1Budget-1834-52', 'row-1Budget-1834-53', 'row-1Budget-1834-54']);
		expect(last.nextPage).toBeNull();
		expect(requested('/v4/spreadsheets/1Budget/values:batchGet').at(-1)?.searchParams.getAll('ranges')).toEqual(["'Alex''s notes'!A102:ZZ1000"]);
	});

	test('a page of rows ending in empty ones goes on at the next row that has any', async () => {
		drive.row = (row) => (row <= 40 || (row >= 75 && row <= 80) ? storedRow(Math.min(row, 54)) : null);
		const {googleConnector} = await import('./google-connector');
		const first = (await googleConnector.list(target, query({parent: 'sheet-1Budget-0'}))).unwrap();

		expect(first.records).toHaveLength(39);
		expect(first.nextPage).toBe('75');
		const second = (await googleConnector.list(target, query({parent: 'sheet-1Budget-0', page: '75'}))).unwrap();
		expect(second.records).toHaveLength(6);
		expect(second.nextPage).toBeNull();
	});

	test("a page of rows past the tab's last row is empty, without asking Sheets for a range outside its grid", async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, query({parent: 'sheet-1Budget-0', page: '121'}))).unwrap();

		expect(page.records).toEqual([]);
		expect(page.nextPage).toBeNull();
		expect(page.trail?.at(-1)).toEqual({id: 'sheet-1Budget-0', title: 'Q1'});
		expect(requested('/v4/spreadsheets/1Budget/values:batchGet')).toHaveLength(0);
	});

	test('a page of the places, or of a spreadsheet’s tabs, is refused, since each is all on one page', async () => {
		const {googleConnector} = await import('./google-connector');
		const lists = [query({page: 'next'}), query({parent: '1Budget', page: 'next'})];

		for (const paged of lists) {
			const result = await googleConnector.list(target, paged);
			expect(result.isErr() && result.error.kind).toBe('validation_error');
		}
	});

	test('a page of rows that is not a row number is refused', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.list(target, query({parent: 'sheet-1Budget-0', page: 'A1'}));

		expect(result.isErr() && result.error.kind).toBe('validation_error');
	});

	test('a folder whose folder the account cannot see is under Shared with me', async () => {
		const {googleConnector} = await import('./google-connector');
		drive.answer = (url) => {
			if (url.pathname === '/drive/v3/files/1Shared') {
				return Response.json({id: '1Shared', name: 'Shared plans', mimeType: 'application/vnd.google-apps.folder', parents: ['1Hidden']});
			}
			return null;
		};
		const page = (await googleConnector.list(target, query({parent: '1Shared'}))).unwrap();

		expect(page.trail).toEqual([
			{id: 'shared-with-me', title: 'Shared with me'},
			{id: '1Shared', title: 'Shared plans'},
		]);
	});
});

test('a file at the top of a shared drive the account is not a member of is under Shared with me', async () => {
	const {googleConnector} = await import('./google-connector');
	drive.answer = (url) => {
		if (url.pathname === '/drive/v3/files/1Theirs') {
			return Response.json({id: '1Theirs', name: 'Their plans', mimeType: 'application/vnd.google-apps.folder', parents: ['0ATheirDrive'], driveId: '0ATheirDrive'});
		}
		if (url.pathname === '/drive/v3/drives/0ATheirDrive') {
			return googleError(404, 'Shared drive not found: 0ATheirDrive', 'notFound');
		}
		return null;
	};
	const page = (await googleConnector.list(target, query({parent: '1Theirs'}))).unwrap();

	expect(page.trail).toEqual([
		{id: 'shared-with-me', title: 'Shared with me'},
		{id: '1Theirs', title: 'Their plans'},
	]);
});

describe('googleConnector.get', () => {
	test('a document opens as Markdown', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, '1Plan')).unwrap();

		expect(requested('/drive/v3/files/1Plan/export')[0]?.searchParams.get('mimeType')).toBe('text/markdown');
		expect(record).toEqual({
			id: '1Plan',
			values: {
				name: 'Launch plan',
				kind: 'Document',
				modified: '2026-10-08T08:16:23.137Z',
				owner: 'Alex Kim',
				content: '# Launch plan\n\n- Ship it',
			},
			updatedAt: '2026-10-08T08:16:23.137Z',
			url: 'https://docs.google.com/document/d/1Plan/edit?usp=drivesdk',
		});
	});

	test('a spreadsheet opens with its tabs one a line', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, '1Budget')).unwrap();

		expect(record.values.content).toBe("Q1: 120 rows, 8 columns\nAlex's notes: 1000 rows, 26 columns");
		expect(record.hasChildren).toBe(true);
	});

	test('a row opens with its values under the headers', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, 'row-1Budget-0-7')).unwrap();

		expect(requested('/v4/spreadsheets/1Budget/values:batchGet')[0]?.searchParams.getAll('ranges')).toEqual(["'Q1'!A1:ZZ1", "'Q1'!A7:ZZ7"]);
		expect(record.values).toMatchObject({name: 'Item 7', kind: 'Row', content: 'Item: Item 7\nAmount: 70\nColumn C: Paid'});
	});

	test("a row past the tab's last row is not found, without asking Sheets for it", async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.get(target, 'row-1Budget-0-121');

		expect(result.isErr() && result.error).toMatchObject({kind: 'not_found', resource: 'record', id: 'row-1Budget-0-121'});
		expect(requested('/v4/spreadsheets/1Budget/values:batchGet')).toHaveLength(0);
	});

	test('a file too large to export says so in its content, and opens otherwise', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, '1Huge')).unwrap();

		expect(record.values).toMatchObject({name: 'Everything ever written', kind: 'Document', content: 'This file is too large to read; Google exports at most 10 MB'});
	});

	test("a disabled API is Google's own message, saying where to enable it", async () => {
		const {googleConnector} = await import('./google-connector');
		const message =
			'Google Sheets API has not been used in project 1234 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1234 then retry.';
		drive.answer = (url) => (url.hostname === 'sheets.googleapis.com' ? googleError(403, message, 'accessNotConfigured') : null);

		const result = await googleConnector.get(target, '1Budget');

		expect(result.isErr() && result.error).toEqual({kind: 'validation_error', statusCode: 400, message});
	});

	test('a file Drive does not have is not found by its id', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.get(target, '1Gone');

		expect(result.isErr() && result.error).toMatchObject({kind: 'not_found', resource: 'record', id: '1Gone'});
	});
});
