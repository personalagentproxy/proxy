import {afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// A Google Drive file's history end to end: the writes through it, the copies kept, the Google
// tools on it and the sweep that lets them go, against the local database and a blob store in a
// temporary directory, with Drive and Sheets faked. Run with the database up (`bun run dev`) and
// the environment loaded, `bun --env-file=../../.env test --isolate src/records/google-history.test.ts`
// from this package. Without DATABASE_URL, as `bun run test` runs, there is nothing to run against,
// and this is skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-drive-history-test-'));

mock.module('../utils/env', () => ({
	env: {
		NODE_ENV: 'production',
		APP_URL: 'https://app.example.com',
		GOOGLE_CLIENT_ID: 'client-1',
		GOOGLE_CLIENT_SECRET: 'secret-1',
		FILES_DIR: blobs,
		FILES_STORE: {kind: 'disk', dir: blobs},
		FILES_MAX_MB: 100,
		DRIVE_COPY_MAX_MB: 1,
	},
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

function refusal<T>(result: Result<T, ApiError>): string {
	if (result.isOk()) {
		throw new Error('expected a refusal');
	}
	return 'message' in result.error && result.error.message ? `${result.error.kind}: ${result.error.message}` : result.error.kind;
}

const MIME = {
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const MB = 1024 * 1024;

// A file in the fake Drive: its revisions, oldest first, each with its bytes, or a Google type's
// export of it; `size` is what Drive says of the head's, which may be more than the bytes held.
type DriveFile = {id: string; name: string; mimeType: string; revisions: {id: string; bytes: Buffer; keepForever: boolean}[]; size?: number; exportRefused?: boolean};

type Cell = {formulaValue?: string; stringValue?: string; numberValue?: number} | null;

type State = {files: Record<string, DriveFile>; grid: Cell[][]};

function fresh(): State {
	const file = (id: string, name: string, mimeType: string, bytes: string, extra: Partial<DriveFile> = {}): DriveFile => ({
		id,
		name,
		mimeType,
		revisions: [{id: `${id}-r1`, bytes: Buffer.from(bytes), keepForever: false}],
		...extra,
	});
	return {
		files: {
			'1Contract': file('1Contract', 'Contract.pdf', 'application/pdf', '%PDF contract, first draft'),
			'1Video': file('1Video', 'Walkthrough.mp4', 'video/mp4', 'not really a video', {size: 5 * MB}),
			'1Plan': file('1Plan', 'Launch plan', MIME.document, '# Launch plan\n\n- Ship it'),
			'1Huge': file('1Huge', 'Huge notes', MIME.document, 'docx of the huge notes', {exportRefused: true}),
			'1Budget': file('1Budget', 'Budget 2026', MIME.spreadsheet, 'xlsx of the budget'),
		},
		grid: [
			[{stringValue: 'Item'}, {stringValue: 'Amount'}],
			[{stringValue: 'Rent'}, {numberValue: 1200}],
			[{stringValue: 'Food'}, {formulaValue: '=B2/4'}],
		],
	};
}

let state = fresh();

type Request = {method: string; url: URL; type: string; headers: Record<string, string>; body: Buffer};

const google = {requests: [] as Request[]};

function head(file: DriveFile) {
	const last = file.revisions.at(-1);
	return last ?? {id: '', bytes: Buffer.from(''), keepForever: false};
}

function stateOf(file: DriveFile): object {
	const google = file.mimeType.startsWith('application/vnd.google-apps.');
	const bytes = head(file).bytes;
	return {
		id: file.id,
		name: file.name,
		mimeType: file.mimeType,
		webViewLink: `https://drive.google.com/open?id=${file.id}`,
		...(google ? {} : {headRevisionId: head(file).id, sha256Checksum: createHash('sha256').update(bytes).digest('hex'), size: String(file.size ?? bytes.length)}),
	};
}

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'File not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

function cellOf(entered: Cell): object {
	return entered === null ? {} : {userEnteredValue: entered};
}

// The grid's cells of `'Q1'!B2:B3`, as Sheets answers them with the grid's data.
function gridOf(range: string): object {
	const [, first = 'A', top = '1', last = 'A', bottom = '1'] = /!([A-Z])(\d+):([A-Z])(\d+)$/.exec(range) ?? [];
	const rows = state.grid.slice(Number(top) - 1, Number(bottom)).map((row) => row.slice(first.charCodeAt(0) - 65, last.charCodeAt(0) - 64));
	return {sheets: [{data: [{startRow: Number(top) - 1, rowData: rows.map((row) => ({values: row.map(cellOf)}))}]}]};
}

function answer(request: Request): Response {
	const {method, url} = request;
	const path = decodeURIComponent(url.pathname);
	if (path === '/v4/spreadsheets/1Budget' && url.searchParams.has('ranges')) {
		return Response.json(gridOf(url.searchParams.get('ranges') ?? ''));
	}
	if (path === '/v4/spreadsheets/1Budget') {
		return Response.json({sheets: [{properties: {sheetId: 3, title: 'Q1', gridProperties: {rowCount: 100, columnCount: 5}}}]});
	}
	if (method === 'POST' && path === '/v4/spreadsheets/1Budget:batchUpdate') {
		for (const {updateCells} of JSON.parse(request.body.toString()).requests) {
			const {range, rows} = updateCells;
			rows.forEach((row: {values: {userEnteredValue?: Cell}[]}, offset: number) => {
				const cells = state.grid[range.startRowIndex + offset] ?? [];
				row.values.forEach((value, column) => {
					cells[range.startColumnIndex + column] = value.userEnteredValue ?? null;
				});
				state.grid[range.startRowIndex + offset] = cells;
			});
		}
		state.files['1Budget']?.revisions.push({id: `1Budget-r${(state.files['1Budget']?.revisions.length ?? 0) + 1}`, bytes: Buffer.from('xlsx'), keepForever: false});
		return Response.json({replies: [{}]});
	}
	if (method === 'PUT' && path.startsWith('/v4/spreadsheets/1Budget/values/')) {
		const {values} = JSON.parse(request.body.toString());
		const [, row = '1'] = /!B(\d+)/.exec(path) ?? [];
		values.forEach(([value = '']: string[], offset: number) => {
			const cells = state.grid[Number(row) - 1 + offset] ?? [];
			cells[1] = value.startsWith('=') ? {formulaValue: value} : {numberValue: Number(value)};
			state.grid[Number(row) - 1 + offset] = cells;
		});
		state.files['1Budget']?.revisions.push({id: `1Budget-r${(state.files['1Budget']?.revisions.length ?? 0) + 1}`, bytes: Buffer.from('xlsx'), keepForever: false});
		return Response.json({updatedRange: `'Q1'!B${row}`, updatedData: {values}});
	}
	const [, id = '', rest = ''] = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)(.*)$/.exec(path) ?? [];
	const file = state.files[id];
	if (!file) {
		return notFound();
	}
	if (rest === '/export') {
		if (file.exportRefused) {
			return Response.json({error: {code: 403, message: 'This file is too large to be exported.', errors: [{reason: 'exportSizeLimitExceeded'}]}}, {status: 403});
		}
		return new Response(new Uint8Array(head(file).bytes));
	}
	if (rest === '/revisions') {
		return Response.json({revisions: file.revisions.map((revision) => ({id: revision.id}))});
	}
	const revision = /^\/revisions\/(.+)$/.exec(rest)?.[1];
	const found = file.revisions.find((candidate) => candidate.id === revision);
	if (revision && !found) {
		return notFound();
	}
	if (found && method === 'PATCH') {
		found.keepForever = JSON.parse(request.body.toString()).keepForever;
		return Response.json({id: found.id, keepForever: found.keepForever});
	}
	if (found) {
		return new Response(new Uint8Array(found.bytes));
	}
	// A resumable upload over the file starts a session, which the bytes are then sent to.
	if (method === 'PATCH' && url.searchParams.get('uploadType') === 'resumable') {
		const session = new URL(url);
		session.searchParams.set('upload_id', `session-${file.id}`);
		return new Response(null, {status: 200, headers: {location: session.href}});
	}
	if ((method === 'PATCH' || method === 'PUT') && path.startsWith('/upload/')) {
		file.revisions.push({id: `${file.id}-r${file.revisions.length + 1}`, bytes: request.body, keepForever: false});
		return Response.json(stateOf(file));
	}
	if (url.searchParams.get('alt') === 'media') {
		return new Response(new Uint8Array(head(file).bytes));
	}
	return Response.json(stateOf(file));
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const headers = new Headers(init?.headers);
	const body = init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.from('');
	const request = {method: init?.method ?? 'GET', url, type: headers.get('content-type') ?? '', headers: Object.fromEntries(headers), body};
	google.requests.push(request);
	return answer(request);
}) as typeof fetch);

// What was asked of Google, as `METHOD path`, without the Sheets reads of tabs.
function asked(): string[] {
	return google.requests.map((request) => `${request.method} ${decodeURIComponent(request.url.pathname)}${request.url.searchParams.get('alt') === 'media' ? '?alt=media' : ''}`);
}

beforeEach(() => {
	google.requests = [];
});

describe.skipIf(!databaseUrl)('a Google Drive file’s history, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let taskId = '';
	let otherTaskId = '';
	let connection: {id: string; orgId: string; credential: string};

	const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'dana@example.com'};

	async function editor(task = taskId) {
		const {changeBy} = await import('./google-history');
		return {token: 'access-1', change: changeBy(connection, {agentId, taskId: task})};
	}

	async function tool(name: string, params: Record<string, unknown>, task = taskId): Promise<Result<string, ApiError>> {
		const {GOOGLE_INTEGRATION} = await import('../connections/google/integration');
		const runner = GOOGLE_INTEGRATION.tools?.[name];
		if (!runner) {
			throw new Error(`no tool ${name}`);
		}
		const agent = {agentId, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
		return runner({caller: {agent, via: 'mcp', taskId: task}, connection: {...connection, integrationId: 'google'} as never, params});
	}

	// A new head written over a file through its history, as an upload over it will be.
	async function writeOver(fileId: string, bytes: string, task = taskId) {
		const {changeDriveFile, loggedAs} = await import('./google-history');
		const {putContent} = await import('../connections/google/drive-api');
		const body = new Response(bytes).body ?? new ReadableStream<Uint8Array>();
		return changeDriveFile(await editor(task), fileId, {content: true}, () => loggedAs({kind: 'write'}, putContent('access-1', fileId, {type: 'application/pdf', body, size: bytes.length})));
	}

	async function versionsOf(fileId: string) {
		const {listFileVersions} = await import('@proxy/db/files');
		return unwrap(await listFileVersions(connection.id, fileId));
	}

	async function changesOf(fileId: string) {
		const {listFileChanges} = await import('@proxy/db/files');
		return unwrap(await listFileChanges(connection.id, fileId, 50));
	}

	async function bytesOf(blobId: string | null): Promise<string> {
		const {getFileBlob} = await import('@proxy/db/files');
		const {readContent} = await import('../native/files/content');
		const blob = unwrap(await getFileBlob(blobId ?? ''));
		return blob ? Buffer.from(unwrap(await readContent(blob))).toString() : '';
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const user = await db.user.create({data: {email: `drive-history-test-${stamp}@example.test`, name: 'Dana'}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Drive history test', slug: `drive-history-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		const made = await db.connection.create({data: {orgId, integrationId: 'google', account: 'dana@example.com', ownerUserId: userId, credential: `enc:${JSON.stringify(CREDENTIAL)}`}});
		connection = {id: made.id, orgId, credential: made.credential ?? ''};
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `drive-history-test-${stamp}`, passwordHash: ''}})).id;
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'Tidy the contracts', goal: 'Tidy', via: 'mcp'}})).id;
		otherTaskId = (await db.agentTask.create({data: {orgId, agentId, title: 'Fill in the budget', goal: 'Fill', via: 'mcp'}})).id;
	});

	afterAll(async () => {
		const {db} = await import('@proxy/db');
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('an uploaded file’s bytes are copied before a task’s first change only, with Drive’s revision, and not again where they are the same', async () => {
		unwrap(await writeOver('1Contract', '%PDF contract, second draft'));
		expect(asked().filter((line) => line.endsWith('?alt=media'))).toEqual(['GET /drive/v3/files/1Contract?alt=media']);

		google.requests = [];
		unwrap(await writeOver('1Contract', '%PDF contract, third draft'));
		expect(asked().filter((line) => line.endsWith('?alt=media'))).toEqual([]);

		const [copy] = await versionsOf('1Contract');
		expect(copy).toMatchObject({sourceRevision: '1Contract-r1', sourceType: null, type: 'application/pdf', pinned: false, size: 26});
		expect(await bytesOf(copy?.blobId ?? null)).toBe('%PDF contract, first draft');
		expect((await changesOf('1Contract')).map((change) => [change.kind, change.beforeVersion === copy?.id, change.beforeRevision, change.afterRevision, change.task?.title])).toEqual([
			['write', false, '1Contract-r2', '1Contract-r3', 'Tidy the contracts'],
			['write', true, '1Contract-r1', '1Contract-r2', 'Tidy the contracts'],
		]);

		// Another task copies what the file holds by then, the first draft again, as someone put it back
		// in Drive: the bytes kept already are pointed at, not downloaded again.
		google.requests = [];
		state.files['1Contract']?.revisions.push({id: '1Contract-r4', bytes: Buffer.from('%PDF contract, first draft'), keepForever: false});
		unwrap(await writeOver('1Contract', '%PDF contract, fourth draft', otherTaskId));
		expect(asked().filter((line) => line.endsWith('?alt=media'))).toEqual([]);
		const [again, kept] = await versionsOf('1Contract');
		expect(again).toMatchObject({sourceRevision: '1Contract-r4', blobId: copy?.blobId, pinned: false});
		expect(kept?.id).toBe(copy?.id ?? '');
	});

	test('an uploaded file past DRIVE_COPY_MAX_MB has its revision kept for good in Drive instead', async () => {
		unwrap(await writeOver('1Video', 'still not a video'));

		expect(asked().filter((line) => line.endsWith('?alt=media'))).toEqual([]);
		expect(state.files['1Video']?.revisions[0]?.keepForever).toBe(true);
		const [pinned] = await versionsOf('1Video');
		expect(pinned).toMatchObject({sourceRevision: '1Video-r1', blobId: null, size: 5 * MB, pinned: true, type: 'video/mp4'});
	});

	test('a Doc is copied as its Markdown export with its latest revision, to be read, and one Drive won’t export as the revision alone', async () => {
		const {filesConnector} = await import('./google-files');
		const {findCollection, findIntegration} = await import('@proxy/integrations');
		const integration = findIntegration('google');
		const collection = integration && findCollection(integration, 'files');
		if (!collection) {
			throw new Error('no files collection');
		}
		const target = {connection: {...connection, integrationId: 'google'} as never, collection, by: {agentId, taskId}};
		const {changeDriveFile, loggedAs} = await import('./google-history');
		unwrap(await changeDriveFile(await editor(), '1Plan', {content: true}, () => loggedAs({kind: 'write'}, Promise.resolve(Ok(null)))));
		unwrap(await filesConnector.commands?.trash?.(target, '1Huge'));
		unwrap(await changeDriveFile(await editor(), '1Huge', {content: true}, () => loggedAs({kind: 'write'}, Promise.resolve(Ok(null)))));

		const [plan] = await versionsOf('1Plan');
		expect(plan).toMatchObject({sourceRevision: '1Plan-r1', sourceType: MIME.document, type: 'text/markdown'});
		expect(await bytesOf(plan?.blobId ?? null)).toBe('# Launch plan\n\n- Ship it');
		expect(google.requests.find((request) => request.url.pathname === '/drive/v3/files/1Plan/export')?.url.searchParams.get('mimeType')).toBe('text/markdown');
		const [huge] = await versionsOf('1Huge');
		expect(huge).toMatchObject({sourceRevision: '1Huge-r1', blobId: null, sourceType: MIME.document, pinned: false});
		// A move to Trash takes no copy, so the write after it was the task's first change to what the file holds.
		expect((await changesOf('1Huge')).map((change) => [change.kind, change.beforeVersion === huge?.id])).toEqual([
			['write', true],
			['trash', false],
		]);
		expect(google.requests.filter((request) => request.method === 'PATCH' && request.url.pathname.includes('/revisions/'))).toEqual([]);
	});

	test('a range written keeps its cells for an exact undo, which files_undo applies only while they hold what it wrote', async () => {
		const {rangesConnector} = await import('./google-ranges');
		const {findCollection, findIntegration} = await import('@proxy/integrations');
		const integration = findIntegration('google');
		const collection = integration && findCollection(integration, 'ranges');
		if (!collection) {
			throw new Error('no ranges collection');
		}
		const target = {connection: {...connection, integrationId: 'google'} as never, collection, by: {agentId, taskId}};
		unwrap(await rangesConnector.newCommands?.write?.(target, {spreadsheet: '1Budget', range: "'Q1'!B2", values: '1500\n=B2/2'}));
		expect(state.grid[2]?.[1]).toEqual({formulaValue: '=B2/2'});

		const [edit] = await changesOf('1Budget');
		expect(edit?.undo).toEqual({kind: 'sheets_cells', sheetId: 3, tab: 'Q1', range: 'B2:B3', before: [[{value: 1200}], [{formula: '=B2/4'}]], after: [[{value: 1500}], [{formula: '=B2/2'}]]});
		const versions = unwrap(await tool('files_versions', {id: '1Budget'}));
		expect(versions).toContain(`${edit?.id}: `);
		expect(versions).toContain('edited, cells B2:B3 of “Q1” by Claude for “Tidy the contracts”; files_undo undoes it exactly');
		expect(versions).toMatch(
			/kept here, \d+ B as application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet, Drive’s revision 1Budget-r1; what it held before it was edited, cells B2:B3 of “Q1” by Claude/,
		);

		const undone = unwrap(await tool('files_undo', {change: edit?.id}, otherTaskId));
		expect(undone).toStartWith(`Put cells B2:B3 of “Q1” in “Budget 2026” back as they were before change ${edit?.id}.`);
		expect(state.grid[1]?.[1]).toEqual({numberValue: 1200});
		expect(state.grid[2]?.[1]).toEqual({formulaValue: '=B2/4'});
		const [undo] = await changesOf('1Budget');
		expect(undo).toMatchObject({kind: 'edit', taskId: otherTaskId, undo: {before: [[{value: 1500}], [{formula: '=B2/2'}]], after: [[{value: 1200}], [{formula: '=B2/4'}]]}});

		// The cells hold what the undo left, not what the change wrote: undoing it again is refused.
		expect(refusal(await tool('files_undo', {change: edit?.id}))).toBe(
			'conflict: The cells B2:B3 of “Q1” changed since that change: read the version from before it with files_version_read and write back what should be there (files_versions lists them)',
		);
		const created = await logCreate('1Budget');
		expect(refusal(await tool('files_undo', {change: created}))).toBe(
			'validation_error: That change has no exact undo: read the version from before it with files_version_read and make the changes back, or, for a file of its own bytes, give it back with files_restore (files_versions lists them)',
		);
		expect(refusal(await tool('files_undo', {change: 'no-such-change'}))).toStartWith('not_found');
	});

	async function logCreate(fileId: string): Promise<string> {
		const {logDriveCreate} = await import('./google-history');
		return (await logDriveCreate(await editor(), {id: fileId}))?.id ?? '';
	}

	test('files_restore gives an uploaded file’s copy back as its newest revision, and never a Doc’s', async () => {
		const [copy] = (await versionsOf('1Contract')).filter((version) => version.blobId !== null);
		google.requests = [];
		const restored = unwrap(await tool('files_restore', {id: 'https://drive.google.com/file/d/1Contract/view', version: copy?.id}));

		// The task kept its copy of the file before its first change to it, so this restore keeps none.
		expect(restored.split('\n')[0]).toBe(
			`“Contract.pdf” holds what version ${copy?.id} held again, as its newest revision in Drive; what it held until now is not kept again: this task kept its copy before its first change to the file (files_versions lists it).`,
		);
		const session = google.requests.find((request) => request.method === 'PATCH' && request.url.pathname.startsWith('/upload/'));
		expect([session?.url.searchParams.get('uploadType'), session?.headers['x-upload-content-type'], session?.headers['x-upload-content-length']]).toEqual(['resumable', 'application/pdf', '26']);
		const put = google.requests.find((request) => request.method === 'PUT');
		expect([put?.url.searchParams.get('upload_id'), put?.type, put?.body.toString()]).toEqual(['session-1Contract', 'application/pdf', '%PDF contract, first draft']);
		const [restore] = await changesOf('1Contract');
		expect(restore).toMatchObject({kind: 'restore', taskId});
		const [made] = await versionsOf('1Contract');
		expect(made).toMatchObject({id: restore?.afterVersion ?? '', blobId: copy?.blobId, sourceRevision: restore?.afterRevision});

		// A Doc is never written over from its copy: its version is read, and given back in Drive's own version history.
		const plan = (await versionsOf('1Plan')).find((version) => version.sourceRevision === '1Plan-r1');
		const changesBefore = (await changesOf('1Plan')).length;
		google.requests = [];
		expect(refusal(await tool('files_restore', {id: '1Plan', version: plan?.id}))).toBe(
			`validation_error: “Launch plan” is never given a version back from here, which would write over it whole, losing its comments, suggestions and what others changed since. Read what version ${plan?.id} held with files_version_read and make the changes back in place, or have a person give it back in Drive’s own version history, File > Version history > See version history at https://drive.google.com/open?id=1Plan, picking the version from ${plan?.createdAt.toISOString()}.`,
		);
		expect(google.requests.filter((request) => request.method !== 'GET')).toEqual([]);
		expect(await changesOf('1Plan')).toHaveLength(changesBefore);
	});

	test('files_version_read reads what a version held as text, a stretch at a time, and one kept only in Drive in Drive’s own history', async () => {
		const plan = (await versionsOf('1Plan')).find((version) => version.sourceRevision === '1Plan-r1');
		expect(unwrap(await tool('files_version_read', {id: 'https://docs.google.com/document/d/1Plan/edit', version: plan?.id}))).toBe(
			[`“Launch plan” as version ${plan?.id} held it, kept ${plan?.createdAt.toISOString()}.`, 'Length: 24 characters', '', '# Launch plan\n\n- Ship it'].join('\n'),
		);
		expect(
			unwrap(await tool('files_version_read', {id: '1Plan', version: plan?.id, from: 15}))
				.split('\n')
				.slice(1),
		).toEqual(['Length: Characters 15 to 24 of 24.', '', '- Ship it']);

		const [huge] = await versionsOf('1Huge');
		expect(refusal(await tool('files_version_read', {id: '1Huge', version: huge?.id}))).toStartWith(
			`validation_error: Personal Agent Proxy kept no copy of version ${huge?.id}, too large to keep, only Drive’s revision: read it in Drive’s own version history`,
		);
		expect(refusal(await tool('files_version_read', {id: '1Plan', version: 'no-such-version'}))).toStartWith('not_found');
	});

	test('files_restore of a version kept only in Drive downloads the revision for an uploaded file, and sends a Doc to Drive’s own history', async () => {
		const [pinned] = await versionsOf('1Video');
		google.requests = [];
		unwrap(await tool('files_restore', {id: '1Video', version: pinned?.id}));
		expect(asked()).toContain('GET /drive/v3/files/1Video/revisions/1Video-r1?alt=media');
		expect(state.files['1Video']?.revisions.at(-1)?.bytes.toString()).toBe('not really a video');

		const [huge] = await versionsOf('1Huge');
		expect(refusal(await tool('files_restore', {id: '1Huge', version: huge?.id}))).toEndWith(
			`have a person give it back in Drive’s own version history, File > Version history > See version history at https://drive.google.com/open?id=1Huge, picking the version from ${huge?.createdAt.toISOString()}.`,
		);
		expect(refusal(await tool('files_restore', {id: '1Huge', version: 'no-such-version'}))).toStartWith('not_found');
	});

	test('the web app’s routes read a file’s history, give a version back and undo a change, as the member’s', async () => {
		const {db} = await import('@proxy/db');
		await db.orgMember.create({data: {orgId, userId}});
		const routes = await import('./google-history-route');
		const request = (params: Record<string, string>, body?: object) =>
			({user: {userId, email: 'dana@example.com'}, params: {org: `drive-history-test-${stamp}`, connectionId: connection.id, ...params}, body, query: {}}) as never;

		const listed = unwrap(await routes.handleListDriveHistoryRoute(request({})));
		expect(listed.files.map((file) => file.id).sort()).toEqual(['1Budget', '1Contract', '1Huge', '1Plan', '1Video']);
		expect(listed.files[0]).toMatchObject({id: '1Video', name: 'Walkthrough.mp4', kind: 'restore', by: {kind: 'agent', name: 'Claude', task: {title: 'Tidy the contracts'}}});

		// A Doc's version kept only in Drive is given back in Drive's own version history, not from here.
		const huge = unwrap(await routes.handleGetDriveHistoryRoute(request({fileId: '1Huge'})));
		expect(huge.file).toEqual({id: '1Huge', name: 'Huge notes', link: 'https://drive.google.com/open?id=1Huge', google: true});
		expect(huge.versions).toEqual([
			expect.objectContaining({kept: 'drive', size: null, restorable: false, origin: 'before', by: expect.objectContaining({kind: 'agent', task: {id: taskId, title: 'Tidy the contracts'}})}),
		]);
		expect(huge.changes.map((change) => change.kind)).toEqual(['write', 'trash']);

		// The latest change of the Sheet's cells is files_undo's own, which put them back: undone in turn.
		const budget = unwrap(await routes.handleGetDriveHistoryRoute(request({fileId: '1Budget'})));
		const latest = budget.changes.find((change) => change.cells !== null);
		expect(latest).toMatchObject({kind: 'edit', cells: {tab: 'Q1', range: 'B2:B3'}, by: {task: {id: otherTaskId}}});
		expect(refusal(await routes.handleUndoDriveChangeRoute(request({fileId: '1Contract', changeId: latest?.id ?? ''})))).toStartWith('not_found');
		unwrap(await routes.handleUndoDriveChangeRoute(request({fileId: '1Budget', changeId: latest?.id ?? ''})));
		expect(state.grid[1]?.[1]).toEqual({numberValue: 1500});
		expect(state.grid[2]?.[1]).toEqual({formulaValue: '=B2/2'});
		const [undone] = await changesOf('1Budget');
		expect(undone).toMatchObject({kind: 'edit', userId, agentId: null, taskId: null, user: {name: 'Dana'}});

		// A member has no task: what the file holds is kept before the restore, unless the latest version holds it already.
		const contract = unwrap(await routes.handleGetDriveHistoryRoute(request({fileId: '1Contract'})));
		const kept = contract.versions.find((version) => version.kept === 'here' && version.origin === 'before');
		expect(kept?.restorable).toBe(true);
		unwrap(await routes.handleRestoreDriveVersionRoute(request({fileId: '1Contract'}, {version: kept?.id ?? ''})));
		expect(head(state.files['1Contract'] as DriveFile).bytes.toString()).toBe('%PDF contract, first draft');
		const [restore] = await changesOf('1Contract');
		expect(restore).toMatchObject({kind: 'restore', userId, agentId: null, taskId: null});
		expect(restore?.beforeVersion).not.toBeNull();
		expect(refusal(await routes.handleRestoreDriveVersionRoute(request({fileId: '1Contract'}, {})))).toStartWith('parse_error');
	});

	test('a write Drive made is answered as made even where logging it fails', async () => {
		const {changeDriveFile, loggedAs, logDriveCreate} = await import('./google-history');
		const {putContent} = await import('../connections/google/drive-api');
		const {log} = await import('../observability/log');
		const errors = spyOn(log, 'error');
		const body = new Response('%PDF contract, fifth draft').body ?? new ReadableStream<Uint8Array>();
		// An undo the journal won't keep, as it is not the shape it has to be, fails the log alone.
		const crooked = {kind: 'sheets_cells' as const, sheetId: 0, tab: 'Q1', range: 'A1:A1', before: [[null]], after: [[]]};
		const written = await changeDriveFile(await editor(), '1Contract', {content: true}, () =>
			loggedAs({kind: 'write', undo: crooked}, putContent('access-1', '1Contract', {type: 'application/pdf', body, size: 26})),
		);

		expect(written.isOk()).toBe(true);
		expect(head(state.files['1Contract'] as DriveFile).bytes.toString()).toBe('%PDF contract, fifth draft');
		expect(errors).toHaveBeenCalledWith('A change made in Google Drive could not be logged in its history', {
			connectionId: connection.id,
			fileId: '1Contract',
			kind: 'write',
			errorKind: 'validation_error',
		});
		expect(await logDriveCreate(await editor(), {id: '1Gone'})).toBeNull();
		expect(errors).toHaveBeenCalledWith('A change made in Google Drive could not be logged in its history', {connectionId: connection.id, fileId: '1Gone', kind: 'create', errorKind: 'not_found'});
	});
});
