import {afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// Uploads into Google Drive through a URL, end to end: files_upload and files_upload_done on a
// Google connection, Drive's resumable sessions they open and ask, the history they log and the
// sweep that cancels what nobody finished, against the local database, with Drive faked. Run with
// the database up and the environment loaded, `bun --env-file=../../.env test --isolate
// src/records/google-uploads.test.ts` from this package. Without DATABASE_URL, as `bun run test`
// runs, there is nothing to run against, and this is skipped. Everything made here is one
// organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-drive-uploads-test-'));

mock.module('../utils/env', () => ({
	env: {
		NODE_ENV: 'production',
		APP_URL: 'https://app.example.com',
		GOOGLE_CLIENT_ID: 'client-1',
		GOOGLE_CLIENT_SECRET: 'secret-1',
		FILES_DIR: blobs,
		FILES_MAX_MB: 100,
		DRIVE_COPY_MAX_MB: 1,
		DRIVE_COPY_KEEP_DAYS: 30,
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

// A resumable upload's session: what it makes, and whether every byte is in, or it was cancelled.
type Session = {fileId: string; create: {name: string; mimeType: string; parents: string[]} | null; size: number; state: 'open' | 'complete' | 'cancelled'};

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

// The bytes, or a question of how many arrived, sent to a session.
function toSession(request: Request, session: Session): Response {
	if (request.method === 'DELETE') {
		session.state = 'cancelled';
		return new Response(null, {status: 499});
	}
	if (session.state === 'cancelled') {
		return notFound();
	}
	const asked = request.headers['content-range'] === `bytes */${session.size}` && request.body.length === 0;
	if (asked) {
		return session.state === 'complete' ? Response.json({id: session.fileId}) : new Response(null, {status: 308});
	}
	session.state = 'complete';
	const existing = state.files[session.fileId];
	if (session.create) {
		const googleType = session.create.mimeType.startsWith('application/vnd.google-apps.');
		state.files[session.fileId] = {
			id: session.fileId,
			...session.create,
			revisions: [{id: `${session.fileId}-r1`, bytes: googleType ? Buffer.from('converted') : request.body}],
			version: 1,
			trashed: false,
		};
		return Response.json({id: session.fileId});
	}
	if (existing) {
		existing.revisions.push({id: `${existing.id}-r${existing.revisions.length + 1}`, bytes: request.body});
		existing.version += 1;
	}
	return Response.json({id: session.fileId});
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
		return openSession({fileId: id, create: {name, mimeType, parents}, size: Number(request.headers['x-upload-content-length']), state: 'open'});
	}
	const [, id = '', rest = ''] = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)(.*)$/.exec(path) ?? [];
	const file = state.files[id];
	if (!file) {
		return notFound();
	}
	if (method === 'PATCH' && path.startsWith('/upload/')) {
		return openSession({fileId: id, create: null, size: Number(request.headers['x-upload-content-length']), state: 'open'});
	}
	if (rest === '/export') {
		return new Response(new Uint8Array(head(file).bytes));
	}
	if (rest === '/revisions') {
		return Response.json({revisions: file.revisions.map((revision) => ({id: revision.id}))});
	}
	const revision = /^\/revisions\/(.+)$/.exec(rest)?.[1];
	if (revision && method === 'DELETE') {
		file.revisions = file.revisions.filter((candidate) => candidate.id !== revision);
		return new Response(null, {status: 204});
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

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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

// The bytes sent to a session's URL, as curl -X PUT --upload-file sends them.
async function put(url: string, bytes: string): Promise<number> {
	return (await fetch(url, {method: 'PUT', body: bytes})).status;
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

	test('a new file goes straight to Drive at its session’s URL, under an id reserved at the start, and done logs it as made', async () => {
		const bytes = '%PDF results';
		const ticket = unwrap(await tool('files_upload', {name: 'Results.pdf', parent: 'drive-0ATeamDrive', size: bytes.length, sha256: sha256(bytes)}));
		const url = lineOf(ticket, 'URL');
		const id = lineOf(ticket, 'Upload');

		expect(url).toBe(`${SESSIONS}s1`);
		expect(ticket).toContain(`curl -X PUT --upload-file <path> '${url}'`);
		expect(ticket).toContain('It takes the file in parts too');
		expect(asked()).toEqual(['GET /drive/v3/files/generateIds', 'POST /upload/drive/v3/files']);
		const [, start] = google.requests;
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({id: '1Gen1', name: 'Results.pdf', mimeType: 'application/pdf', parents: ['0ATeamDrive']});
		expect([start?.url.searchParams.get('uploadType'), start?.url.searchParams.get('supportsAllDrives'), start?.headers['x-upload-content-length'], start?.headers['x-upload-content-type']]).toEqual([
			'resumable',
			'true',
			String(bytes.length),
			'application/pdf',
		]);
		// The session's address is kept only encrypted, and Personal Agent Proxy serves no URL of its own for it.
		expect(await uploadOf(id)).toMatchObject({sessionUri: `enc:${url}`, secretHash: null, fileId: '1Gen1', status: 'open'});

		expect(refusal(await tool('files_upload_done', {upload: id}))).toStartWith(`validation_error: Nothing has arrived for upload ${id} yet`);
		expect(await put(url, bytes)).toBe(200);
		google.requests = [];
		const done = unwrap(await tool('files_upload_done', {upload: id}));

		expect(done).toBe(['Added Results.pdf.', 'Id: 1Gen1', 'Version: 1Gen1-r1', 'Size: 12 B', 'Link: https://drive.google.com/open?id=1Gen1'].join('\n'));
		// The session is asked with nothing sent and no token, as its address is its own credential.
		const [question] = google.requests;
		expect([question?.method, question?.headers['content-range'], question?.headers.authorization, question?.body.length]).toEqual(['PUT', `bytes */${bytes.length}`, undefined, 0]);
		expect((await changesOf('1Gen1')).map((change) => [change.kind, change.afterRevision, change.taskId])).toEqual([['create', '1Gen1-r1', taskId]]);
		expect(unwrap(await tool('files_upload_done', {upload: id}))).toBe(done);
		expect(await uploadOf(id)).toMatchObject({status: 'done', afterVersion: '1Gen1-r1'});
	});

	test('with convert, a docx becomes a Doc named without its extension, and what Drive converted is taken as said', async () => {
		const ticket = unwrap(await tool('files_upload', {name: 'Q3 review.docx', parent: '1Projects', size: 9, convert: true}));
		const {fileId} = await uploadOf(lineOf(ticket, 'Upload'));
		const [, , start] = google.requests;
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({id: fileId, name: 'Q3 review', mimeType: MIME.document, parents: ['1Projects']});
		expect(start?.headers['x-upload-content-type']).toBe(MIME.docx);

		expect(await put(lineOf(ticket, 'URL'), 'docx 9 b.')).toBe(200);
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		expect(lineOf(done, 'Id')).toBe(fileId ?? '');
		expect(lineOf(done, 'Version')).toBe('1');
		expect(state.files[fileId ?? '']?.mimeType).toBe(MIME.document);
	});

	test('over a file, the version read is checked and the task’s copy kept before the session is opened, and done logs the write between Drive’s revisions', async () => {
		const stale = await tool('files_upload', {id: '1Contract', version: '1Contract-r0', size: 4});
		expect(refusal(stale)).toBe(
			'conflict: “Contract.pdf” changed since version 1Contract-r0: it is at 1Contract-r1 now. Look at it again, then upload what you make of it with the version files_versions says it is at.',
		);
		expect(asked()).toEqual(['GET /drive/v3/files/1Contract']);
		expect(unwrap(await tool('files_versions', {id: '1Contract'}))).toContain('Version in Drive now: 1Contract-r1, which files_upload takes to write over it');

		google.requests = [];
		const bytes = '%PDF second draft';
		const ticket = unwrap(await tool('files_upload', {id: 'https://drive.google.com/file/d/1Contract/view', version: '1Contract-r1', size: bytes.length, sha256: sha256(bytes)}));
		const download = asked().indexOf('GET /drive/v3/files/1Contract?alt=media');
		expect(download).toBeGreaterThan(-1);
		expect(asked().indexOf('PATCH /upload/drive/v3/files/1Contract')).toBeGreaterThan(download);
		const [copy] = await versionsOf('1Contract');
		expect(copy).toMatchObject({sourceRevision: '1Contract-r1', type: 'application/pdf'});
		expect(await uploadOf(lineOf(ticket, 'Upload'))).toMatchObject({target: 'write', fileId: '1Contract', version: '1Contract-r1', beforeRevision: '1Contract-r1', beforeVersion: copy?.id});

		expect(await put(lineOf(ticket, 'URL'), bytes)).toBe(200);
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		expect(done).toStartWith('Wrote Contract.pdf. The version before is kept.\nId: 1Contract\nVersion: 1Contract-r2');
		expect((await changesOf('1Contract')).map((change) => [change.kind, change.beforeVersion, change.beforeRevision, change.afterRevision])).toEqual([
			['write', copy?.id ?? null, '1Contract-r1', '1Contract-r2'],
		]);
	});

	test('a Doc is written over from a docx, checked against Drive’s version number, and converted by Drive', async () => {
		const ticket = unwrap(await tool('files_upload', {id: '1Plan', version: '7', size: 4}));
		const session = google.requests.find((request) => request.method === 'PATCH');
		expect([session?.url.pathname, session?.headers['x-upload-content-type'], session?.body.toString()]).toEqual(['/upload/drive/v3/files/1Plan', MIME.docx, '{}']);

		expect(await put(lineOf(ticket, 'URL'), 'docx')).toBe(200);
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		expect(lineOf(done, 'Version')).toBe('8');
		const [write] = await changesOf('1Plan');
		expect(write).toMatchObject({kind: 'write', beforeRevision: '1Plan-r1', afterRevision: '1Plan-r2'});
	});

	test('Markdown or CSV over a file, anything but its own Office file over a Doc or a Sheet, Google’s types and what convert can’t make are refused before any session', async () => {
		const refusals = await Promise.all([
			tool('files_upload', {id: '1Notes', version: '1Notes-r1', size: 4}),
			tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 4, type: 'text/markdown'}),
			tool('files_upload', {id: '1Budget', version: '7', size: 4, type: 'text/csv'}),
			tool('files_upload', {id: '1Plan', version: '7', size: 4, type: 'application/pdf'}),
			tool('files_upload', {id: '1Projects', version: '7', size: 4}),
			tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 4, convert: true}),
			tool('files_upload', {name: 'Plan', size: 4, type: MIME.document}),
			tool('files_upload', {name: 'scan.pdf', size: 4, convert: true}),
			tool('files_upload', {name: 'scan.pdf', parent: '1Budget', size: 4}),
			tool('files_upload', {name: 'scan.pdf', parent: 'recent', size: 4}),
		]);

		expect(refusals.map(refusal)).toEqual([
			'validation_error: Markdown is never uploaded over a file that is there, since a Doc or a Sheet would lose what it can’t hold, as its formatting and formulas. For “notes.md”, upload it as a new file, with name and parent, instead.',
			'validation_error: Markdown is never uploaded over a file that is there, since a Doc or a Sheet would lose what it can’t hold, as its formatting and formulas. For “Contract.pdf”, upload it as a new file, with name and parent, instead.',
			'validation_error: CSV is never uploaded over a file that is there, since a Doc or a Sheet would lose what it can’t hold, as its formatting and formulas. For “Budget 2026”, write its cells with ranges_write, or upload an xlsx over it.',
			'validation_error: A Doc is written over only from a docx, which Drive converts into it, and this is application/pdf',
			'validation_error: “Projects” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it',
			'validation_error: convert makes a new file into a Doc, Sheet or Slides file; a file written over keeps its own kind: leave convert out',
			'validation_error: A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert',
			'validation_error: convert makes a Doc of a docx or Markdown, a Sheet of an xlsx or CSV, and a Slides file of a pptx, and this is application/pdf: leave convert out to keep it as it is',
			'validation_error: A spreadsheet holds tabs: upload the file into a folder',
			'validation_error: Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
		]);
		expect(google.requests.filter((request) => request.url.pathname.startsWith('/upload/'))).toEqual([]);
		expect(google.requests.filter((request) => request.url.pathname.endsWith('/generateIds'))).toEqual([]);
	});

	test('bytes that aren’t what was said are taken back out of Drive: a new file moved to Trash, a revision over a file deleted', async () => {
		const made = unwrap(await tool('files_upload', {name: 'chart.png', size: 5, sha256: sha256('chart')}));
		expect(await put(lineOf(made, 'URL'), 'graph')).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(made, 'Upload')}))).toStartWith(`conflict: The bytes that arrived for chart.png have the SHA-256 ${sha256('graph')}`);
		const {fileId} = await uploadOf(lineOf(made, 'Upload'));
		expect(state.files[fileId ?? '']?.trashed).toBe(true);
		expect(await changesOf(fileId ?? '')).toEqual([]);

		const logged = (await changesOf('1Contract')).length;
		const over = unwrap(await tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 5, sha256: sha256('right')}));
		expect(await put(lineOf(over, 'URL'), 'wrong')).toBe(200);
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1', '1Contract-r2']);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(over, 'Upload')}))).toStartWith('conflict: The bytes that arrived for Contract.pdf');
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1']);
		expect(await changesOf('1Contract')).toHaveLength(logged);
		// Refused for good: asked again, it says so, and takes nothing more back.
		google.requests = [];
		expect(refusal(await tool('files_upload_done', {upload: lineOf(over, 'Upload')}))).toStartWith('conflict: The bytes that arrived for Contract.pdf');
		expect(google.requests).toEqual([]);
	});

	// The session an upload's URL is of, in the fake Drive.
	function sessionOf(ticket: string): Session | undefined {
		return state.sessions[new URL(lineOf(ticket, 'URL')).searchParams.get('upload_id') ?? ''];
	}

	async function pastItsHour(ticket: string, by = 1000) {
		const {db} = await import('@proxy/db');
		await db.fileUpload.update({where: {id: lineOf(ticket, 'Upload')}, data: {expiresAt: new Date(Date.now() - by)}});
	}

	test('past its hour, the sweep cancels a session the bytes are still coming to, with a DELETE at its address and no token, and lets go of one Drive no longer has', async () => {
		const {sweepUploads} = await import('../uploads/sweeper');
		const uploading = unwrap(await tool('files_upload', {name: 'late.pdf', size: 4}));
		const gone = unwrap(await tool('files_upload', {name: 'gone.pdf', size: 4}));
		const lost = sessionOf(gone);
		if (lost) {
			lost.state = 'cancelled';
		}
		await pastItsHour(uploading);
		await pastItsHour(gone);
		google.requests = [];

		await sweepUploads();
		const cancels = google.requests.filter((request) => request.method === 'DELETE');
		expect(cancels.map((request) => [request.url.href, request.headers.authorization])).toEqual([[lineOf(uploading, 'URL'), undefined]]);
		expect(sessionOf(uploading)?.state).toBe('cancelled');
		expect((await uploadOf(lineOf(uploading, 'Upload'))).status).toBe('expired');
		expect((await uploadOf(lineOf(gone, 'Upload'))).status).toBe('expired');
		expect(refusal(await tool('files_upload_done', {upload: lineOf(uploading, 'Upload')}))).toStartWith('conflict: This upload expired');
	});

	test('bytes all in by the hour are kept for done an hour more, which finishes them as in time', async () => {
		const {sweepUploads} = await import('../uploads/sweeper');
		const ticket = unwrap(await tool('files_upload', {name: 'slow.pdf', size: 4, sha256: sha256('slow')}));
		expect(await put(lineOf(ticket, 'URL'), 'slow')).toBe(200);
		await pastItsHour(ticket);
		google.requests = [];

		await sweepUploads();
		expect(google.requests.filter((request) => request.method !== 'PUT')).toEqual([]);
		expect(sessionOf(ticket)?.state).toBe('complete');
		expect((await uploadOf(lineOf(ticket, 'Upload'))).status).toBe('open');

		const done = unwrap(await tool('files_upload_done', {upload: lineOf(ticket, 'Upload')}));
		const {fileId} = await uploadOf(lineOf(ticket, 'Upload'));
		expect(done).toStartWith(`Added slow.pdf.\nId: ${fileId}`);
		expect(state.files[fileId ?? '']?.trashed).toBe(false);
		expect((await changesOf(fileId ?? '')).map((change) => change.kind)).toEqual(['create']);
	});

	test('bytes nobody finished an hour past the upload’s own are taken back out of Drive, as only done makes a file', async () => {
		const {sweepUploads} = await import('../uploads/sweeper');
		const HOURS = 2 * 60 * 60_000;
		const made = unwrap(await tool('files_upload', {name: 'forgotten.pdf', size: 4}));
		expect(await put(lineOf(made, 'URL'), 'lost')).toBe(200);
		const logged = (await changesOf('1Contract')).length;
		const over = unwrap(await tool('files_upload', {id: '1Contract', version: '1Contract-r1', size: 5}));
		expect(await put(lineOf(over, 'URL'), 'later')).toBe(200);
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1', '1Contract-r2']);
		await pastItsHour(made, HOURS);
		await pastItsHour(over, HOURS);

		await sweepUploads();
		const {fileId} = await uploadOf(lineOf(made, 'Upload'));
		expect(state.files[fileId ?? '']?.trashed).toBe(true);
		expect(state.files['1Contract']?.revisions.map((revision) => revision.id)).toEqual(['1Contract-r1']);
		expect((await uploadOf(lineOf(made, 'Upload'))).status).toBe('expired');
		expect((await uploadOf(lineOf(over, 'Upload'))).status).toBe('expired');
		expect(await changesOf(fileId ?? '')).toEqual([]);
		expect(await changesOf('1Contract')).toHaveLength(logged);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(made, 'Upload')}))).toStartWith('conflict: This upload expired');
	});
});
