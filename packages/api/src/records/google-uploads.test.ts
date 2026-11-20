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

// Uploads into Google Drive through a URL, end to end: files_upload and files_upload_done on a
// Google connection, the bytes PUT to Personal Agent Proxy's own URL and sent on to Drive only at
// done, the history they log, and the sweep that lets go of what nobody finished, against the
// local database, with Drive faked. Run with the database up and the environment loaded,
// `bun --env-file=../../.env test --isolate src/records/google-uploads.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const APP_URL = 'https://app.example.com';

const blobs = mkdtempSync(join(tmpdir(), 'proxy-drive-uploads-test-'));

mock.module('../utils/env', () => ({
	env: {
		NODE_ENV: 'production',
		APP_URL,
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
	folder: 'application/vnd.google-apps.folder',
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

// A file in the fake Drive: its revisions, oldest first, each with its bytes, or a Google type's
// export of it, and Drive's version number, which goes up with every change.
type DriveFile = {id: string; name: string; mimeType: string; parents: string[]; revisions: {id: string; bytes: Buffer}[]; version: number; trashed: boolean};

// A resumable upload's session, which Personal Agent Proxy opens at done: what it makes.
type Session = {fileId: string; create: {name: string; mimeType: string; parents: string[]} | null};

type State = {files: Record<string, DriveFile>; sessions: Record<string, Session>};

// The ids Drive reserved, counted across the tests, as the history they log is kept across them.
let generated = 0;

function fresh(): State {
	const file = (id: string, name: string, mimeType: string, bytes: string): DriveFile => ({
		id,
		name,
		mimeType,
		parents: ['1Projects'],
		revisions: [{id: `${id}-r1`, bytes: Buffer.from(bytes)}],
		version: 7,
		trashed: false,
	});
	return {
		files: {
			'1Projects': {...file('1Projects', 'Projects', MIME.folder, ''), revisions: []},
			'1Contract': file('1Contract', 'Contract.pdf', 'application/pdf', '%PDF first draft'),
			'1Notes': file('1Notes', 'notes.md', 'text/markdown', '# Notes'),
			'1Plan': file('1Plan', 'Launch plan', MIME.document, 'docx of the launch plan'),
			'1Budget': file('1Budget', 'Budget 2026', MIME.spreadsheet, 'xlsx of the budget'),
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
		version: String(file.version),
		...(googleType ? {} : {headRevisionId: head(file).id, sha256Checksum: createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length)}),
	};
}

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'File not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

const SESSIONS = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=';

function openSession(session: Session): Response {
	const id = `s${Object.keys(state.sessions).length + 1}`;
	state.sessions[id] = session;
	return new Response(null, {status: 200, headers: {location: `${SESSIONS}${id}`}});
}

// The bytes sent to a session, in one PUT: the file made, or its new revision.
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

function answer(request: Request): Response {
	const {method, url} = request;
	const path = decodeURIComponent(url.pathname);
	const sessionId = url.searchParams.get('upload_id');
	const session = sessionId ? state.sessions[sessionId] : undefined;
	if (sessionId) {
		return session ? toSession(request, session) : notFound();
	}
	if (path === '/drive/v3/files/generateIds') {
		generated += 1;
		return Response.json({ids: [`1Gen${generated}`]});
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
	const file = state.files[id];
	if (!file) {
		return notFound();
	}
	if (method === 'PATCH' && path.startsWith('/upload/')) {
		return openSession({fileId: id, create: null});
	}
	if (rest === '/export') {
		return new Response(new Uint8Array(head(file).bytes));
	}
	if (rest === '/revisions') {
		return Response.json({revisions: file.revisions.map((revision) => ({id: revision.id}))});
	}
	if (method === 'PATCH') {
		Object.assign(file, JSON.parse(request.body.toString()));
		return Response.json(stateOf(file));
	}
	if (url.searchParams.get('alt') === 'media') {
		return new Response(new Uint8Array(head(file).bytes));
	}
	return Response.json(stateOf(file));
}

// Personal Agent Proxy's own upload route, served here, is reached as it is; everything else is Google.
const realFetch = globalThis.fetch;
let origin = '';

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	if (origin !== '' && url.origin === origin) {
		return realFetch(url, init);
	}
	const headers = new Headers(init?.headers);
	const body = init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.from('');
	const request = {method: init?.method ?? 'GET', url, headers: Object.fromEntries(headers), body};
	google.requests.push(request);
	return answer(request);
}) as typeof fetch);

// What was asked of Google, as `METHOD path`, a session's by its id.
function asked(): string[] {
	return google.requests.map((request) => {
		const session = request.url.searchParams.get('upload_id');
		return `${request.method} ${session ? `session ${session}` : decodeURIComponent(request.url.pathname)}${request.url.searchParams.get('alt') === 'media' ? '?alt=media' : ''}`;
	});
}

function lineOf(text: string, label: string): string {
	return new RegExp(`^${label}: (.+)$`, 'm').exec(text)?.[1] ?? '';
}

// The bytes sent to an upload's URL, as curl -X PUT --upload-file sends them.
async function put(url: string, bytes: string): Promise<number> {
	return (await fetch(url.replace(APP_URL, origin), {method: 'PUT', body: bytes})).status;
}

beforeEach(() => {
	state = fresh();
	google.requests = [];
});

describe.skipIf(!databaseUrl)('uploads into Google Drive, through a URL', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let taskId = '';
	let connection: {id: string; orgId: string; credential: string};
	let server: Server | undefined;

	const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'dana@example.com'};

	async function tool(name: string, params: Record<string, unknown>): Promise<Result<string, ApiError>> {
		const {GOOGLE_INTEGRATION} = await import('../connections/google/integration');
		const runner = GOOGLE_INTEGRATION.tools?.[name];
		if (!runner) {
			throw new Error(`no tool ${name}`);
		}
		const agent = {agentId, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
		return runner({caller: {agent, via: 'mcp', taskId}, connection: {...connection, integrationId: 'google'} as never, params});
	}

	async function uploadOf(id: string) {
		const {db} = await import('@proxy/db');
		return db.fileUpload.findUniqueOrThrow({where: {id}});
	}

	async function changesOf(fileId: string) {
		const {listFileChanges} = await import('@proxy/db/files');
		return unwrap(await listFileChanges(connection.id, fileId, 50));
	}

	async function versionsOf(fileId: string) {
		const {listFileVersions} = await import('@proxy/db/files');
		return unwrap(await listFileVersions(connection.id, fileId));
	}

	// What was sent to Drive's upload endpoints: the sessions opened and the bytes sent to them.
	function uploadsToDrive(): Request[] {
		return google.requests.filter((request) => request.url.pathname.startsWith('/upload/'));
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const user = await db.user.create({data: {email: `drive-uploads-test-${stamp}@example.test`, name: 'Dana'}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Drive uploads test', slug: `drive-uploads-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		const made = await db.connection.create({data: {orgId, integrationId: 'google', account: 'dana@example.com', ownerUserId: userId, credential: `enc:${JSON.stringify(CREDENTIAL)}`}});
		connection = {id: made.id, orgId, credential: made.credential ?? ''};
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `drive-uploads-test-${stamp}`, passwordHash: ''}})).id;
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'File the results', goal: 'File', via: 'mcp'}})).id;

		const {UPLOADS_PATH} = await import('@proxy/contracts/uploads');
		const {handleUploadBytesRoute} = await import('../native/files/upload-route');
		const app = express();
		app.put(`${UPLOADS_PATH}/:secret`, (request, response) => void handleUploadBytesRoute(request, response));
		server = app.listen(0);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server?.close();
		const {db} = await import('@proxy/db');
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('a new file’s bytes come to Personal Agent Proxy’s URL, and only done makes the file in Drive, under the id reserved at the start', async () => {
		const bytes = '%PDF results';
		const ticket = unwrap(await tool('files_upload', {name: 'Results.pdf', parent: 'drive-0ATeamDrive', size: bytes.length, sha256: sha256(bytes)}));
		const url = lineOf(ticket, 'URL');
		const id = lineOf(ticket, 'Upload');

		expect(url).toStartWith(`${APP_URL}/api/uploads/`);
		expect(ticket).toContain(`curl -X PUT --upload-file <path> '${url}'`);
		expect(asked()).toEqual(['GET /drive/v3/files/generateIds']);
		expect(await uploadOf(id)).toMatchObject({fileId: '1Gen1', status: 'open'});

		expect(refusal(await tool('files_upload_done', {upload: id}))).toStartWith(`validation_error: Nothing has arrived for upload ${id} yet`);
		expect(await put(url, bytes)).toBe(200);
		expect(state.files['1Gen1']).toBeUndefined();
		expect(uploadsToDrive()).toEqual([]);

		google.requests = [];
		const done = unwrap(await tool('files_upload_done', {upload: id}));
		expect(done).toBe(['Added Results.pdf.', 'Id: 1Gen1', 'Version: 1Gen1-r1', 'Size: 12 B', 'Link: https://drive.google.com/open?id=1Gen1'].join('\n'));
		const [start, sent] = uploadsToDrive();
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({id: '1Gen1', name: 'Results.pdf', mimeType: 'application/pdf', parents: ['0ATeamDrive']});
		expect([start?.headers['x-upload-content-length'], start?.headers['x-upload-content-type']]).toEqual([String(bytes.length), 'application/pdf']);
		expect(sent?.body.toString()).toBe(bytes);
		expect(state.files['1Gen1']?.parents).toEqual(['0ATeamDrive']);
		expect((await changesOf('1Gen1')).map((change) => [change.kind, change.afterRevision, change.taskId])).toEqual([['create', '1Gen1-r1', taskId]]);

		// Asked again, it answers as it did, and sends nothing more to Drive.
		google.requests = [];
		expect(unwrap(await tool('files_upload_done', {upload: id}))).toBe(done);
		expect(uploadsToDrive()).toEqual([]);
		expect(await uploadOf(id)).toMatchObject({status: 'done', afterVersion: '1Gen1-r1'});
	});

	test('with convert, a docx becomes a Doc named without its extension, under an id Drive gives it, as it reserves none for what it converts', async () => {
		const ticket = unwrap(await tool('files_upload', {name: 'Q3 review.docx', parent: '1Projects', size: 9, convert: true}));
		expect(await uploadOf(lineOf(ticket, 'Upload'))).toMatchObject({fileId: null, convert: true});
		expect(google.requests.filter((request) => request.url.pathname.endsWith('/generateIds'))).toEqual([]);
		expect(uploadsToDrive()).toEqual([]);

		expect(await put(lineOf(ticket, 'URL'), 'docx 9 b.')).toBe(200);
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		const [start] = uploadsToDrive();
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({name: 'Q3 review', mimeType: MIME.document, parents: ['1Projects']});
		expect(start?.headers['x-upload-content-type']).toBe(MIME.docx);
		const id = lineOf(done, 'Id');
		expect(lineOf(done, 'Version')).toBe('1');
		expect(state.files[id]?.mimeType).toBe(MIME.document);
		expect((await uploadOf(lineOf(ticket, 'Upload'))).fileId).toBe(id);
		expect((await changesOf(id)).map((change) => change.kind)).toEqual(['create']);
	});

	test('over a file, the version read is checked at the start, and at done the task’s copy is kept, the bytes sent and the write logged between Drive’s revisions', async () => {
		const stale = await tool('files_upload', {id: '1Contract', version: '1Contract-r0', size: 4});
		expect(refusal(stale)).toBe(
			'conflict: “Contract.pdf” changed since version 1Contract-r0: it is at 1Contract-r1 now. Look at it again, then upload what you make of it with the version files_versions says it is at.',
		);
		expect(asked()).toEqual(['GET /drive/v3/files/1Contract']);

		google.requests = [];
		const bytes = '%PDF second draft';
		const ticket = unwrap(await tool('files_upload', {id: 'https://drive.google.com/file/d/1Contract/view', version: '1Contract-r1', size: bytes.length, sha256: sha256(bytes)}));
		// Nothing is copied, and nothing goes to Drive, until done.
		expect(asked()).toEqual(['GET /drive/v3/files/1Contract']);
		expect(await uploadOf(lineOf(ticket, 'Upload'))).toMatchObject({target: 'write', fileId: '1Contract', version: '1Contract-r1'});

		expect(await put(lineOf(ticket, 'URL'), bytes)).toBe(200);
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1']);
		google.requests = [];
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		expect(done).toStartWith('Wrote Contract.pdf. The version before is kept.\nId: 1Contract\nVersion: 1Contract-r2');
		const download = asked().indexOf('GET /drive/v3/files/1Contract?alt=media');
		expect(download).toBeGreaterThan(-1);
		expect(asked().indexOf('PATCH /upload/drive/v3/files/1Contract')).toBeGreaterThan(download);
		expect(state.files['1Contract']?.revisions.at(-1)?.bytes.toString()).toBe(bytes);
		const [copy] = await versionsOf('1Contract');
		expect(copy).toMatchObject({sourceRevision: '1Contract-r1', type: 'application/pdf'});
		expect((await changesOf('1Contract')).map((change) => [change.kind, change.beforeVersion, change.beforeRevision, change.afterRevision])).toEqual([
			['write', copy?.id ?? null, '1Contract-r1', '1Contract-r2'],
		]);
	});

	test('a file changed in Drive between the start and done is not written over: done refuses, for good, and sends nothing', async () => {
		const ticket = unwrap(await tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 5}));
		expect(await put(lineOf(ticket, 'URL'), 'later')).toBe(200);
		state.files['1Contract']?.revisions.push({id: '1Contract-r2', bytes: Buffer.from('%PDF edited by Dana')});
		const logged = (await changesOf('1Contract')).length;

		google.requests = [];
		expect(refusal(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}))).toStartWith('conflict: “Contract.pdf” changed since version 1Contract-r1: it is at 1Contract-r2 now.');
		expect(uploadsToDrive()).toEqual([]);
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1', '1Contract-r2']);
		expect(await changesOf('1Contract')).toHaveLength(logged);
		expect((await uploadOf(lineOf(ticket, 'Upload'))).status).toBe('failed');
	});

	test('Markdown goes over a file of its own bytes as any bytes do, a notes.md written over with a newer one', async () => {
		const ticket = unwrap(await tool('files_upload', {id: '1Notes', version: '1Notes-r1', size: 8}));
		expect(await put(lineOf(ticket, 'URL'), '# Notes!')).toBe(200);
		unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));

		const [session] = uploadsToDrive();
		expect([session?.method, session?.url.pathname, session?.headers['x-upload-content-type']]).toEqual(['PATCH', '/upload/drive/v3/files/1Notes', 'text/markdown']);
		const [write] = await changesOf('1Notes');
		expect(write).toMatchObject({kind: 'write', beforeRevision: '1Notes-r1'});
	});

	test('anything over a Doc or a Sheet, Google’s types, what convert can’t make and a file too large are refused at the start', async () => {
		const refusals = await Promise.all([
			tool('files_upload', {id: '1Plan', version: '7', size: 4}),
			tool('files_upload', {id: '1Plan', version: '7', size: 4, type: 'text/markdown'}),
			tool('files_upload', {id: '1Budget', version: '7', size: 4, type: 'text/csv'}),
			tool('files_upload', {id: '1Projects', version: '7', size: 4}),
			tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 4, convert: true}),
			tool('files_upload', {name: 'Plan', size: 4, type: MIME.document}),
			tool('files_upload', {name: 'scan.pdf', size: 4, convert: true}),
			tool('files_upload', {name: 'scan.pdf', parent: '1Budget', size: 4}),
			tool('files_upload', {name: 'scan.pdf', parent: 'recent', size: 4}),
			tool('files_upload', {name: 'huge.zip', size: 101 * 1024 * 1024}),
		]);

		expect(refusals.map(refusal)).toEqual([
			'validation_error: “Launch plan” is a Doc, which is never written over whole, since it would lose its comments, suggestions and formatting: edit its text in place with docs_edit, or upload the file as a new Doc, with name, parent and convert.',
			'validation_error: “Launch plan” is a Doc, which is never written over whole, since it would lose its comments, suggestions and formatting: edit its text in place with docs_edit, or upload the file as a new Doc, with name, parent and convert.',
			'validation_error: “Budget 2026” is a Sheet, which is never written over whole, since it would lose its comments, suggestions and formatting: write its cells with ranges_write, and change its rows, columns and tabs with sheets_rows and sheets_tabs, or upload the file as a new Sheet, with name, parent and convert.',
			'validation_error: “Projects” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it',
			'validation_error: convert makes a new file into a Doc, Sheet or Slides file; a file written over keeps its own kind: leave convert out',
			'validation_error: A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert',
			'validation_error: convert makes a Doc of a docx or Markdown, a Sheet of an xlsx or CSV, and a Slides file of a pptx, and this is application/pdf: leave convert out to keep it as it is',
			'validation_error: A spreadsheet holds tabs: upload the file into a folder',
			'validation_error: Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
			`validation_error: A file is at most 100.0 MB on this server, ${100 * 1024 * 1024} bytes, and this one is ${101 * 1024 * 1024}.`,
		]);
		expect(uploadsToDrive()).toEqual([]);
		expect(google.requests.filter((request) => request.url.pathname.endsWith('/generateIds'))).toEqual([]);
	});

	test('bytes that aren’t what was said never reach Drive: nothing is made, and nothing written over', async () => {
		const made = unwrap(await tool('files_upload', {name: 'chart.png', size: 5, sha256: sha256('chart')}));
		expect(await put(lineOf(made, 'URL'), 'graph')).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(made, 'Upload')}))).toStartWith(`conflict: The bytes that arrived for chart.png have the SHA-256 ${sha256('graph')}`);
		const {fileId} = await uploadOf(lineOf(made, 'Upload'));
		expect(state.files[fileId ?? '']).toBeUndefined();

		const over = unwrap(await tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 6}));
		expect(await put(lineOf(over, 'URL'), 'short')).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(over, 'Upload')}))).toStartWith('conflict: Contract.pdf was to be 6 bytes, and 5 arrived');
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1']);
		expect(uploadsToDrive()).toEqual([]);

		// Refused for good: asked again, it says so, and asks nothing of Drive.
		google.requests = [];
		expect(refusal(await tool('files_upload_done', {upload: lineOf(over, 'Upload')}))).toStartWith('conflict: Contract.pdf was to be 6 bytes');
		expect(google.requests).toEqual([]);
	});

	test('a done asked again after Drive made the file finds it under its reserved id, and doesn’t make it twice', async () => {
		const ticket = unwrap(await tool('files_upload', {name: 'twice.pdf', size: 4}));
		expect(await put(lineOf(ticket, 'URL'), 'once')).toBe(200);
		const {fileId} = await uploadOf(lineOf(ticket, 'Upload'));
		const id = fileId ?? '';
		// As a done before that sent the bytes and then couldn't say so.
		state.files[id] = {id, name: 'twice.pdf', mimeType: 'application/pdf', parents: ['root'], revisions: [{id: `${id}-r1`, bytes: Buffer.from('once')}], version: 1, trashed: false};

		google.requests = [];
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		expect(lineOf(done, 'Version')).toBe(`${id}-r1`);
		expect(uploadsToDrive()).toEqual([]);
	});

	async function pastItsHour(ticket: string, by = 1000) {
		const {db} = await import('@proxy/db');
		await db.fileUpload.update({where: {id: lineOf(ticket, 'Upload')}, data: {expiresAt: new Date(Date.now() - by)}});
	}

	test('the sweep lets go of what nobody finished, and asks nothing of Drive, which has none of it', async () => {
		const {sweepUploads} = await import('../uploads/sweeper');
		const HOURS = 2 * 60 * 60_000;
		const idle = unwrap(await tool('files_upload', {name: 'late.pdf', size: 4}));
		const forgotten = unwrap(await tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 5}));
		expect(await put(lineOf(forgotten, 'URL'), 'later')).toBe(200);
		const kept = unwrap(await tool('files_upload', {name: 'slow.pdf', size: 4}));
		expect(await put(lineOf(kept, 'URL'), 'slow')).toBe(200);
		await pastItsHour(idle);
		await pastItsHour(forgotten, HOURS);
		await pastItsHour(kept);

		google.requests = [];
		await sweepUploads();
		expect(google.requests).toEqual([]);
		expect((await uploadOf(lineOf(idle, 'Upload'))).status).toBe('expired');
		expect((await uploadOf(lineOf(forgotten, 'Upload'))).status).toBe('expired');
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1']);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(idle, 'Upload')}))).toStartWith('conflict: This upload expired');

		// Bytes all in by the hour are kept for done an hour more, which finishes them as in time.
		expect((await uploadOf(lineOf(kept, 'Upload'))).status).toBe('open');
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(kept, 'Upload')}));
		expect(done).toStartWith('Added slow.pdf.');
	});
});
