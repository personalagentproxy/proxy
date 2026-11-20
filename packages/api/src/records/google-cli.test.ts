import {afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import express from 'express';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import type {CliRequest} from '../server/middleware/require-cli';

// A Google connection's Drive as code in a sandbox reaches it with `pap files`, end to end: the
// routes over HTTP, as the token's agent and task, through the gate and into the activity log and
// the files' history, against the local database, with Drive and Sheets faked. Run with the
// database up and the environment loaded, `bun --env-file=../../.env test --isolate
// src/records/google-cli.test.ts` from this package. Without DATABASE_URL, as `bun run test` runs,
// there is nothing to run against, and this is skipped. Everything made here is one
// organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-google-cli-test-'));

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

const MIME = {
	folder: 'application/vnd.google-apps.folder',
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MY_DRIVE = '0AMyDrive';

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

// A file in the fake Drive: its revisions, oldest first, each with its bytes, or what a Google
// type exports; Drive's version number; whether it is shared with the account; and, for a test of
// Drive's export limit, whether it is past it.
type DriveFile = {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	driveId?: string;
	revisions: {id: string; bytes: Buffer}[];
	version: number;
	trashed: boolean;
	shared?: boolean;
	tooLarge?: boolean;
};

type Session = {fileId: string; create: {name: string; mimeType: string; parents: string[]} | null};

type State = {files: Record<string, DriveFile>; sessions: Record<string, Session>};

const DRIVES = [{id: '0AResearch', name: 'Research'}];

// A tab of the fake spreadsheet, as Sheets answers its values.
const TABS: Record<string, string[][]> = {
	Summary: [['Quarter', 'Total']],
	Q3: [
		['Month', 'Note'],
		['July', 'Pricing review, with Dana'],
		['August', 'Said "yes"'],
	],
};

let generated = 0;

function fresh(): State {
	const file = (id: string, name: string, mimeType: string, parents: string[], bytes = ''): DriveFile => ({
		id,
		name,
		mimeType,
		parents,
		revisions: mimeType === MIME.folder ? [] : [{id: `${id}-r1`, bytes: Buffer.from(bytes)}],
		version: 7,
		trashed: false,
	});
	return {
		files: {
			'1Reports': file('1Reports', 'Reports', MIME.folder, [MY_DRIVE]),
			'1Q3': file('1Q3', 'q3.pdf', 'application/pdf', ['1Reports'], '%PDF quarter'),
			'1Plan': file('1Plan', 'Launch plan', MIME.document, ['1Reports'], 'the launch plan'),
			'1Budget': file('1Budget', 'Budget', MIME.spreadsheet, ['1Reports'], 'the budget'),
			'1Huge': {...file('1Huge', 'Handbook', MIME.document, ['1Reports'], 'a handbook'), tooLarge: true},
			'1Twin': file('1Twin', 'notes.txt', 'text/plain', [MY_DRIVE], 'one'),
			'2Twin': file('2Twin', 'notes.txt', 'text/plain', [MY_DRIVE], 'two'),
			'1Lab': {...file('1Lab', 'Lab notes.pdf', 'application/pdf', ['0AResearch'], '%PDF lab'), driveId: '0AResearch'},
			'1Shared': {...file('1Shared', 'Brief.pdf', 'application/pdf', ['1Elsewhere'], '%PDF brief'), shared: true},
		},
		sessions: {},
	};
}

let state = fresh();

type Request = {method: string; url: URL; headers: Record<string, string>; body: Buffer};

const google = {requests: [] as Request[]};

function head(file: DriveFile) {
	return file.revisions.at(-1) ?? {id: '', bytes: Buffer.from('')};
}

function stateOf(file: DriveFile): object {
	const googleType = file.mimeType.startsWith('application/vnd.google-apps.');
	const bytes = head(file).bytes;
	return {
		id: file.id,
		name: file.name,
		mimeType: file.mimeType,
		webViewLink: `https://drive.google.com/open?id=${file.id}`,
		parents: file.parents,
		...(file.driveId ? {driveId: file.driveId} : {}),
		modifiedTime: '2026-11-01T10:00:00.000Z',
		version: String(file.version),
		...(googleType ? {} : {headRevisionId: head(file).id, sha256Checksum: createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length)}),
	};
}

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'File not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

// Drive's query, as far as pap files asks it: a parent, a name, shared with the account, not trashed.
function matches(file: DriveFile, q: string): boolean {
	return q.split(' and ').every((term) => {
		const parent = /^'(.+)' in parents$/.exec(term)?.[1];
		if (parent !== undefined) {
			return file.parents.includes(parent === 'root' ? MY_DRIVE : parent);
		}
		const name = /^name = '(.*)'$/.exec(term)?.[1];
		if (name !== undefined) {
			return file.name === name.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		}
		if (term === 'sharedWithMe = true') {
			return file.shared === true;
		}
		if (term === 'trashed = false') {
			return !file.trashed;
		}
		throw new Error(`The fake Drive can't read ${term}`);
	});
}

const SESSIONS = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=';

function openSession(session: Session): Response {
	const id = `s${Object.keys(state.sessions).length + 1}`;
	state.sessions[id] = session;
	return new Response(null, {status: 200, headers: {location: `${SESSIONS}${id}`}});
}

// The bytes sent to a session, which Personal Agent Proxy opens at done, in one PUT: the file made, or its new revision.
function toSession(request: Request, session: Session): Response {
	if (session.create) {
		const googleType = session.create.mimeType.startsWith('application/vnd.google-apps.');
		const made: DriveFile = {
			id: session.fileId,
			...session.create,
			revisions: [{id: `${session.fileId}-r1`, bytes: googleType ? Buffer.from('converted') : request.body}],
			version: 1,
			trashed: false,
		};
		state.files[session.fileId] = made;
		return Response.json(stateOf(made));
	}
	const existing = state.files[session.fileId];
	if (!existing) {
		return notFound();
	}
	existing.revisions.push({id: `${existing.id}-r${existing.revisions.length + 1}`, bytes: request.body});
	existing.version += 1;
	return Response.json(stateOf(existing));
}

function sheets(request: Request): Response {
	const [, , , id = '', , range = ''] = decodeURIComponent(request.url.pathname).split('/');
	if (id !== '1Budget') {
		return notFound();
	}
	if (range === '') {
		return Response.json({sheets: Object.entries(TABS).map(([title, rows], index) => ({properties: {sheetId: index, title, gridProperties: {rowCount: rows.length, columnCount: 2}}}))});
	}
	const title = /^'(.+)'!/.exec(range)?.[1] ?? '';
	return Response.json({range, values: TABS[title] ?? []});
}

function answer(request: Request): Response {
	const {method, url} = request;
	if (url.hostname === 'sheets.googleapis.com') {
		return sheets(request);
	}
	const path = decodeURIComponent(url.pathname);
	const sessionId = url.searchParams.get('upload_id');
	if (sessionId) {
		const session = state.sessions[sessionId];
		return session ? toSession(request, session) : notFound();
	}
	if (path === '/drive/v3/files/generateIds') {
		generated += 1;
		return Response.json({ids: [`1Gen${generated}`]});
	}
	if (path === '/drive/v3/drives') {
		const named = /^name contains '(.*)'$/.exec(url.searchParams.get('q') ?? '')?.[1];
		return Response.json({drives: DRIVES.filter((drive) => named === undefined || drive.name.includes(named))});
	}
	const drive = /^\/drive\/v3\/drives\/(.+)$/.exec(path)?.[1];
	if (drive) {
		const found = DRIVES.find((one) => one.id === drive);
		return found ? Response.json(found) : notFound();
	}
	if (method === 'GET' && path === '/drive/v3/files') {
		const q = url.searchParams.get('q') ?? '';
		return Response.json({
			files: Object.values(state.files)
				.filter((file) => matches(file, q))
				.map(stateOf),
		});
	}
	if (method === 'POST' && path === '/drive/v3/files') {
		const {name, mimeType, parents} = JSON.parse(request.body.toString());
		generated += 1;
		const id = `1Folder${generated}`;
		state.files[id] = {id, name, mimeType, parents, revisions: [], version: 1, trashed: false};
		return Response.json(stateOf(state.files[id]));
	}
	if (method === 'POST' && path === '/upload/drive/v3/files') {
		const {id, name, mimeType, parents} = JSON.parse(request.body.toString());
		// As Drive: a reserved id is taken only for a file kept as its bytes, not one it converts.
		if (id !== undefined && String(mimeType).startsWith('application/vnd.google-apps.')) {
			return Response.json({error: {code: 400, message: 'Generated IDs are not supported for Docs Editors formats.', errors: [{reason: 'badRequest'}]}}, {status: 400});
		}
		generated += id === undefined ? 1 : 0;
		return openSession({fileId: id ?? `1Made${generated}`, create: {name, mimeType, parents}});
	}
	const [, id = '', rest = ''] = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)(.*)$/.exec(path) ?? [];
	if (id === 'root' || id === MY_DRIVE) {
		return Response.json({id: MY_DRIVE, name: 'My Drive', mimeType: MIME.folder});
	}
	const file = state.files[id];
	if (!file) {
		return notFound();
	}
	if (method === 'PATCH' && path.startsWith('/upload/')) {
		return openSession({fileId: id, create: null});
	}
	if (rest === '/export') {
		if (file.tooLarge) {
			return Response.json({error: {code: 403, message: 'This file is too large to be exported.', errors: [{reason: 'exportSizeLimitExceeded'}]}}, {status: 403});
		}
		return new Response(`${url.searchParams.get('mimeType')} of ${file.name}`);
	}
	if (rest === '/revisions') {
		return Response.json({revisions: file.revisions.map((revision) => ({id: revision.id}))});
	}
	const revision = /^\/revisions\/(.+)$/.exec(rest)?.[1];
	if (revision && url.searchParams.get('alt') === 'media') {
		const found = file.revisions.find((one) => one.id === revision);
		return found ? new Response(new Uint8Array(found.bytes)) : notFound();
	}
	if (url.searchParams.get('alt') === 'media') {
		return new Response(new Uint8Array(head(file).bytes));
	}
	return Response.json(stateOf(file));
}

const realFetch = globalThis.fetch;

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	// The test's own server, where the routes are.
	if (url.hostname === '127.0.0.1') {
		return realFetch(url, init);
	}
	const headers = new Headers(init?.headers);
	const body = init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.from('');
	const request = {method: init?.method ?? 'GET', url, headers: Object.fromEntries(headers), body};
	google.requests.push(request);
	return answer(request);
}) as typeof fetch);

beforeEach(() => {
	state = fresh();
	google.requests = [];
});

describe.skipIf(!databaseUrl)('pap files, on a Google connection', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let taskId = '';
	let agentId = '';
	// An agent that may not read the drive.
	let strangerId = '';
	let server: Server | null = null;
	let origin = '';

	const CREDENTIAL = {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		scopes: ['https://www.googleapis.com/auth/drive'],
		email: 'dana@example.com',
	};

	function pap(path: string, init: RequestInit & {as?: string} = {}): Promise<Response> {
		const {as = agentId, ...rest} = init;
		return fetch(`${origin}${path}`, {...rest, headers: {...rest.headers, 'x-test-agent': as}});
	}

	function ls(path?: string, as?: string): Promise<Response> {
		return pap(`/files/${connectionId}/list${path === undefined ? '' : `?${new URLSearchParams({path}).toString()}`}`, {as});
	}

	function pull(query: Record<string, string>, as?: string): Promise<Response> {
		return pap(`/files/${connectionId}/content?${new URLSearchParams(query).toString()}`, {as});
	}

	function saidOf(response: Response) {
		return JSON.parse(decodeURIComponent(response.headers.get('x-pap-file') ?? 'null'));
	}

	function start(query: Record<string, string>, content: string): Promise<Response> {
		const params = new URLSearchParams({...query, size: String(Buffer.byteLength(content)), sha256: sha256(content)});
		return pap(`/files/${connectionId}/uploads?${params.toString()}`, {method: 'POST'});
	}

	// A push as `pap files push` makes it: started, the bytes sent to Personal Agent Proxy's URL, and done.
	async function push(query: Record<string, string>, content: string): Promise<Response> {
		const started = await start(query, content);
		if (started.status !== 200) {
			return started;
		}
		const {upload, put} = await started.json();
		expect(put.url).toStartWith('https://app.example.com/api/uploads/');
		expect((await fetch(put.url.replace('https://app.example.com', origin), {method: 'PUT', body: content})).status).toBe(200);
		return pap(`/files/${connectionId}/uploads/${upload}/done`, {method: 'POST'});
	}

	async function messageOf(response: Response): Promise<string> {
		expect(response.status).toBe(422);
		return (await response.json()).message;
	}

	// What was asked of Drive, as `METHOD path`, with the query where it is a search.
	function asked(): string[] {
		return google.requests.map((request) => `${request.method} ${decodeURIComponent(request.url.pathname)}${request.url.searchParams.get('q') ? ` q=${request.url.searchParams.get('q')}` : ''}`);
	}

	async function logged() {
		const {db} = await import('@proxy/db');
		const entries = await db.auditEntry.findMany({where: {orgId, connectionId}, orderBy: {createdAt: 'asc'}});
		return entries.map((entry) => [entry.collectionId, entry.action, entry.outcome, entry.via]);
	}

	async function changesOf(fileId: string) {
		const {listFileChanges} = await import('@proxy/db/files');
		const changes = await listFileChanges(connectionId, fileId, 50);
		if (changes.isErr()) {
			throw new Error(JSON.stringify(changes.error));
		}
		return changes.value;
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const user = await db.user.create({data: {email: `google-cli-test-${stamp}@example.test`, name: 'Dana'}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Google cli test', slug: `google-cli-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		await db.orgMember.create({data: {orgId, userId}});
		const connection = await db.connection.create({data: {orgId, integrationId: 'google', account: 'dana@example.com', ownerUserId: userId, credential: `enc:${JSON.stringify(CREDENTIAL)}`}});
		connectionId = connection.id;
		await db.connectionDefault.createMany({data: ['readFiles', 'createFiles', 'editFiles'].map((actionId) => ({connectionId, actionId}))});
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `google-cli-test-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		strangerId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Stranger', username: `google-cli-test-stranger-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		await db.agentGrant.create({data: {agentId: strangerId, connectionId, actionId: 'readFiles', allowed: false}});
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'File the quarter', goal: 'File', via: 'mcp'}})).id;

		const {handleCliFinishUploadRoute, handleCliListFilesRoute, handleCliPullFileRoute, handleCliStartUploadRoute} = await import('../native/files/cli');
		const guarded = (handler: (request: CliRequest, response: express.Response) => Promise<void>) => (request: express.Request, response: express.Response) => {
			const as = request.get('x-test-agent') ?? '';
			const agent = {agentId: as, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
			void handler(Object.assign(request, {cli: {agent, taskId, sandboxId: 'sandbox-1'}}), response);
		};
		const app = express();
		app.get('/files/:connectionId/list', guarded(handleCliListFilesRoute));
		app.get('/files/:connectionId/content', guarded(handleCliPullFileRoute));
		app.post('/files/:connectionId/uploads', guarded(handleCliStartUploadRoute));
		app.post('/files/:connectionId/uploads/:upload/done', guarded(handleCliFinishUploadRoute));
		const {UPLOADS_PATH} = await import('@proxy/contracts/uploads');
		const {handleUploadBytesRoute} = await import('../native/files/upload-route');
		app.put(`${UPLOADS_PATH}/:secret`, (request, response) => void handleUploadBytesRoute(request, response));
		server = app.listen(0);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server?.close();
		const {db} = await import('@proxy/db');
		if (orgId !== '') {
			await db.auditEntry.deleteMany({where: {orgId}});
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('lists Drive’s places at the top, and a folder, a shared drive and Shared with me by their paths', async () => {
		const top = await (await ls()).json();
		expect(top).toEqual({
			path: '',
			files: [
				{id: 'root', name: 'My Drive', path: 'My Drive', folder: true, version: null, size: null, type: null},
				{id: 'shared-drives', name: 'Shared drives', path: 'Shared drives', folder: true, version: null, size: null, type: null},
				{id: 'shared-with-me', name: 'Shared with me', path: 'Shared with me', folder: true, version: null, size: null, type: null},
			],
		});
		expect(google.requests).toEqual([]);

		const reports = await (await ls('My Drive/Reports')).json();
		expect(reports.files.map((file: {path: string; version: string | null; size: number | null}) => [file.path, file.version, file.size])).toEqual([
			['My Drive/Reports/q3.pdf', '1Q3-r1', 12],
			['My Drive/Reports/Launch plan', '7', null],
			['My Drive/Reports/Budget', '7', null],
			['My Drive/Reports/Handbook', '7', null],
		]);
		expect(asked()).toEqual(["GET /drive/v3/files q='root' in parents and name = 'Reports' and trashed = false", "GET /drive/v3/files q='1Reports' in parents and trashed = false"]);

		expect((await (await ls('Shared drives')).json()).files).toEqual([{id: 'drive-0AResearch', name: 'Research', path: 'Shared drives/Research', folder: true, version: null, size: null, type: null}]);
		google.requests = [];
		expect((await (await ls('Shared drives/Research')).json()).files.map((file: {path: string}) => file.path)).toEqual(['Shared drives/Research/Lab notes.pdf']);
		const inDrive = google.requests.at(-1);
		expect([
			inDrive?.url.searchParams.get('corpora'),
			inDrive?.url.searchParams.get('driveId'),
			inDrive?.url.searchParams.get('supportsAllDrives'),
			inDrive?.url.searchParams.get('includeItemsFromAllDrives'),
		]).toEqual(['drive', '0AResearch', 'true', 'true']);
		expect((await (await ls('Shared with me')).json()).files.map((file: {path: string}) => file.path)).toEqual(['Shared with me/Brief.pdf']);

		expect(await messageOf(await ls('My Drive/Archive'))).toBe('There is no My Drive/Archive in this drive.');
		expect(await messageOf(await ls('My Drive/Reports/q3.pdf'))).toBe('My Drive/Reports/q3.pdf is a file: pap files pull reads it.');
		expect(await messageOf(await ls('Reports'))).toStartWith('A path in Google Drive starts at one of its places: My Drive, Shared drives and the drive’s name, or Shared with me');
	});

	test('pulls a file with bytes of its own as they are, streamed from Drive, now or at a revision, by path or by id', async () => {
		const pulled = await pull({path: 'My Drive/Reports/q3.pdf'});
		expect(pulled.status).toBe(200);
		expect(saidOf(pulled)).toEqual({id: '1Q3', name: 'q3.pdf', path: 'My Drive/Reports/q3.pdf', folder: false, version: '1Q3-r1', size: 12, type: 'application/pdf', format: null});
		expect(pulled.headers.get('content-length')).toBe('12');
		expect(await pulled.text()).toBe('%PDF quarter');

		state.files['1Q3']?.revisions.push({id: '1Q3-r2', bytes: Buffer.from('%PDF quarter, revised')});
		const old = await pull({id: '1Q3', version: '1Q3-r1'});
		expect(saidOf(old)).toMatchObject({version: '1Q3-r1', size: null});
		expect(await old.text()).toBe('%PDF quarter');

		// By its id, or its link, its path found by walking up its folders.
		const lab = await pull({id: 'https://drive.google.com/file/d/1Lab/view'});
		expect(saidOf(lab)).toMatchObject({id: '1Lab', path: 'Shared drives/Research/Lab notes.pdf'});
		expect(saidOf(await pull({id: '1Shared'}))).toMatchObject({path: 'Shared with me/Brief.pdf'});

		expect(await messageOf(await pull({path: 'My Drive/Reports/q3.pdf', as: 'docx'}))).toBe(
			'“q3.pdf” is a file of its own bytes, application/pdf, and is pulled as they are: leave --as and --tab out.',
		);
		expect(await messageOf(await pull({path: 'My Drive/Reports'}))).toBe('Reports is a folder: pap files ls lists it.');
		expect(await messageOf(await pull({path: 'My Drive/Reports/none.pdf'}))).toBe('There is no My Drive/Reports/none.pdf in this drive.');
	});

	test('pulls a Doc as Markdown, a Sheet as xlsx, or as another export, named with its extension, and a Sheet’s tab as CSV', async () => {
		const doc = await pull({path: 'My Drive/Reports/Launch plan'});
		expect(saidOf(doc)).toEqual({id: '1Plan', name: 'Launch plan.md', path: 'My Drive/Reports/Launch plan', folder: false, version: '7', size: null, type: 'text/markdown', format: 'md'});
		expect(doc.headers.get('content-length')).toBeNull();
		expect(await doc.text()).toBe('text/markdown of Launch plan');

		const docx = await pull({path: 'My Drive/Reports/Launch plan', as: 'docx'});
		expect(saidOf(docx)).toMatchObject({name: 'Launch plan.docx', type: MIME.docx, format: 'docx'});
		expect(await docx.text()).toBe(`${MIME.docx} of Launch plan`);

		const sheet = await pull({path: 'My Drive/Reports/Budget'});
		expect(saidOf(sheet)).toMatchObject({name: 'Budget.xlsx', type: MIME.xlsx, format: 'xlsx'});

		const tab = await pull({path: 'My Drive/Reports/Budget', as: 'csv', tab: 'Q3'});
		expect(saidOf(tab)).toMatchObject({name: 'Budget.csv', type: 'text/csv', format: 'csv', size: 69});
		expect(await tab.text()).toBe('Month,Note\r\nJuly,"Pricing review, with Dana"\r\nAugust,"Said ""yes"""\r\n');

		expect(await messageOf(await pull({path: 'My Drive/Reports/Budget', as: 'csv', tab: 'Q4'}))).toBe('“Budget” has no tab “Q4”: its tabs are “Summary”, “Q3”.');
		expect(await messageOf(await pull({path: 'My Drive/Reports/Budget', tab: 'Q3'}))).toBe('--tab names the tab of a Sheet pulled as CSV: pull it with --as csv --tab <tab>.');
		expect(await messageOf(await pull({path: 'My Drive/Reports/Launch plan', as: 'pptx'}))).toBe('A Doc is pulled as md, docx, pdf, txt, not pptx.');
		expect(await messageOf(await pull({path: 'My Drive/Reports/Launch plan', version: '6'}))).toStartWith('Drive exports “Launch plan” only as it is now, at version 7');
		expect(await messageOf(await pull({path: 'My Drive/Reports/Handbook', as: 'docx'}))).toBe(
			'“Handbook” is too large to export as docx: Drive exports at most 10 MB. Pull it --as pdf, or as something smaller, as --as md or --as txt.',
		);
	});

	test('refuses a name more than one file has, listing their ids, and takes one by its id', async () => {
		expect(await messageOf(await pull({path: 'My Drive/notes.txt'}))).toBe(
			'More than one file in My Drive is called “notes.txt”: 1Twin (text/plain, changed 2026-11-01T10:00:00.000Z), 2Twin (text/plain, changed 2026-11-01T10:00:00.000Z). Name the one you mean by its id: pap files pull <connection> --id <id>, or pap files push <file> <connection> --id <id> to write over it.',
		);
		expect(await (await pull({id: '2Twin'})).text()).toBe('two');

		const pushed = await push({id: '2Twin', version: '2Twin-r1', file: 'notes.txt'}, 'two, revised');
		expect(pushed.status).toBe(200);
		expect((await pushed.json()).file).toMatchObject({id: '2Twin', path: 'My Drive/notes.txt', version: '2Twin-r2'});
		expect(head(state.files['1Twin'] as DriveFile).bytes.toString()).toBe('one');
	});

	test('pushes a new file into folders it makes on the way, logged as the agent’s, as its bytes straight to Drive', async () => {
		const pushed = await push({path: 'My Drive/Reports/2026/Q4/summary.pdf', file: 'summary.pdf'}, '%PDF summary');
		expect(pushed.status).toBe(200);
		const made = await pushed.json();
		expect(made).toMatchObject({created: true, file: {name: 'summary.pdf', path: 'My Drive/Reports/2026/Q4/summary.pdf', folder: false, size: 12, type: 'application/pdf'}});

		const folders = Object.values(state.files).filter((file) => file.mimeType === MIME.folder && file.id !== '1Reports');
		const [year = '', quarter = ''] = folders.map((folder) => folder.id);
		expect(folders.map((folder) => [folder.name, folder.parents])).toEqual([
			['2026', ['1Reports']],
			['Q4', [year]],
		]);
		const summary = state.files[made.file.id];
		expect([summary?.parents, head(summary as DriveFile).bytes.toString()]).toEqual([[quarter], '%PDF summary']);
		for (const id of [year, quarter, made.file.id]) {
			expect((await changesOf(id)).map((change) => [change.kind, change.agentId, change.taskId])).toEqual([['create', agentId, taskId]]);
		}

		// Nothing reaches Drive before done, not even the folders on the way.
		expect((await start({path: 'My Drive/Reports/Drafts/notes.pdf', file: 'notes.pdf'}, 'never sent')).status).toBe(200);
		expect(Object.values(state.files).filter((file) => file.name === 'Drafts')).toEqual([]);

		// Nothing is made where Drive makes nothing.
		expect(await messageOf(await start({path: 'Shared with me/New/summary.pdf'}, 'x'))).toBe('Nothing can be made in Shared with me: make it in a folder, My Drive or a shared drive');
		expect(await messageOf(await start({path: 'My Drive/Reports/q3.pdf/inside.pdf'}, 'x'))).toBe('My Drive/Reports/q3.pdf is a file, so nothing goes inside it.');
	});

	test('with --as, makes a Doc of Markdown or a Sheet of CSV, named without the extension; refuses what it can’t make one of', async () => {
		const pushed = await push({path: 'My Drive/Reports/Retro.md', file: 'Retro.md', as: 'doc'}, '# Retro');
		expect(pushed.status).toBe(200);
		const session = google.requests.find((request) => request.url.pathname === '/upload/drive/v3/files');
		expect(JSON.parse(session?.body.toString() ?? '{}')).toMatchObject({name: 'Retro', mimeType: MIME.document, parents: ['1Reports']});
		expect(session?.headers['x-upload-content-type']).toBe('text/markdown');

		expect(await messageOf(await start({path: 'My Drive/Reports/scan.pdf', file: 'scan.pdf', as: 'doc'}, 'x'))).toBe(
			'--as doc makes a Doc of a .docx or Markdown, and this is application/pdf: push it without --as to keep it as it is.',
		);
		expect(await messageOf(await start({path: 'My Drive/Reports/q3.pdf', file: 'q3.docx', as: 'doc', force: '1'}, 'x'))).toBe(
			'--as doc makes a new Doc, and “q3.pdf” is there already: push to a new path, or without --as to write over it.',
		);
	});

	test('never pushes over a Doc or a Sheet, saying what to do instead, and writes over a file of its own bytes at the version pulled, with a copy kept first', async () => {
		const plan = saidOf(await pull({path: 'My Drive/Reports/Launch plan', as: 'docx'}));
		expect(await messageOf(await start({path: 'My Drive/Reports/Launch plan', file: 'Launch plan.docx', version: plan.version}, 'docx'))).toBe(
			'“Launch plan” is a Doc, which is never pushed over, since it would lose its comments, suggestions and formatting: edit its text in place with the docs_edit tool, or push the file to a new path with --as to make a new Doc of it.',
		);
		expect(await messageOf(await start({path: 'My Drive/Reports/Launch plan', file: 'Launch plan.md', force: '1'}, '# Plan'))).toStartWith('“Launch plan” is a Doc, which is never pushed over');
		expect(await messageOf(await start({path: 'My Drive/Reports/Budget', file: 'Budget.csv', force: '1'}, 'a,b'))).toBe(
			'“Budget” is a Sheet, which is never pushed over, since it would lose its comments, suggestions and formatting: write its cells with the ranges_write tool, and change its rows, columns and tabs with sheets_rows and sheets_tabs, or push the file to a new path with --as to make a new Sheet of it.',
		);
		expect(await messageOf(await start({path: 'My Drive/Reports/q3.pdf', file: 'q3.pdf'}, '%PDF'))).toBe(
			'My Drive/Reports/q3.pdf is there already: it holds version 1Q3-r1 now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.',
		);
		expect(google.requests.filter((request) => request.url.pathname.startsWith('/upload/'))).toEqual([]);

		const pulled = saidOf(await pull({path: 'My Drive/Reports/q3.pdf'}));
		const written = await push({path: 'My Drive/Reports/q3.pdf', file: 'q3.pdf', version: pulled.version}, '%PDF revised');
		expect(written.status).toBe(200);
		expect((await written.json()).file).toMatchObject({id: '1Q3', path: 'My Drive/Reports/q3.pdf', type: 'application/pdf'});
		const [write] = await changesOf('1Q3');
		expect(write).toMatchObject({kind: 'write', agentId, taskId, beforeRevision: '1Q3-r1'});
		expect(write?.beforeVersion).not.toBeNull();

		expect(await messageOf(await start({path: 'My Drive/Reports/q3.pdf', file: 'q3.pdf', version: pulled.version}, '%PDF'))).toStartWith('My Drive/Reports/q3.pdf changed since it was pulled');
	});

	test('reads and writes only as the agent may, each logged as the read or the upload it is, from a sandbox', async () => {
		const before = (await logged()).length;
		expect((await ls('My Drive', strangerId)).status).toBe(422);
		expect((await pull({path: 'My Drive/Reports/q3.pdf'}, strangerId)).status).toBe(422);
		expect((await pull({path: 'My Drive/Reports/q3.pdf'})).status).toBe(200);
		expect((await push({path: 'My Drive/Reports/q3.pdf', file: 'q3.pdf', force: '1'}, '%PDF new')).status).toBe(200);

		expect((await logged()).slice(before)).toEqual([
			['files', 'list', 'denied', 'cli'],
			['files', 'view', 'denied', 'cli'],
			['files', 'view', 'allowed', 'cli'],
			['tools', 'files_upload', 'allowed', 'cli'],
			['tools', 'files_upload_done', 'allowed', 'cli'],
		]);
	});
});
