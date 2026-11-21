import {afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// Blobs into and out of Google Drive, end to end: files_upload putting an agent's blob in Drive,
// as a new file or over one, the history it logs, files_blob making a blob of a Drive file, and
// an email's attachment made a blob and put in Drive, against the local database, with Drive and
// Gmail faked. Run with the database up and the environment loaded,
// `bun --env-file=../../.env test --isolate src/records/google-uploads.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const APP_URL = 'https://app.example.com';

const blobs = mkdtempSync(join(tmpdir(), 'proxy-drive-blobs-test-'));

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

// A file in the fake Drive: its revisions, oldest first, each with its bytes, or a Google type's
// export of it, and Drive's version number, which goes up with every change.
type DriveFile = {id: string; name: string; mimeType: string; parents: string[]; revisions: {id: string; bytes: Buffer}[]; version: number; trashed: boolean};

// A resumable upload's session, which putting a blob in Drive opens: what it makes.
type Session = {fileId: string; create: {name: string; mimeType: string; parents: string[]} | null};

type State = {files: Record<string, DriveFile>; sessions: Record<string, Session>};

// The files Drive made, counted across the tests, as the history they log is kept across them.
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

// An email in the fake Gmail, with a PDF attached, its bytes fetched by the attachment's id.
const EMAIL = {id: '18f0a1b2c3d4e5f6', attachmentId: 'ANGjdJ8-pdf', bytes: '%PDF signed contract'};

function gmailAnswer(messageId: string, attachmentId: string | null): Response {
	if (messageId !== EMAIL.id) {
		return notFound();
	}
	if (attachmentId !== null) {
		return attachmentId === EMAIL.attachmentId ? Response.json({data: Buffer.from(EMAIL.bytes).toString('base64url')}) : notFound();
	}
	const parts = [
		{mimeType: 'text/plain', body: {size: 5, data: Buffer.from('Hi Dana').toString('base64url')}},
		{mimeType: 'application/pdf', filename: 'Signed contract.pdf', body: {size: EMAIL.bytes.length, attachmentId: EMAIL.attachmentId}},
	];
	return Response.json({id: EMAIL.id, threadId: EMAIL.id, labelIds: ['INBOX'], payload: {mimeType: 'multipart/mixed', headers: [{name: 'Subject', value: 'The contract'}], parts}});
}

function answer(request: Request): Response {
	const {method, url} = request;
	const path = decodeURIComponent(url.pathname);
	const sessionId = url.searchParams.get('upload_id');
	const session = sessionId ? state.sessions[sessionId] : undefined;
	if (sessionId) {
		return session ? toSession(request, session) : notFound();
	}
	const gmail = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(?:\/attachments\/(.+))?$/.exec(path);
	if (gmail) {
		return gmailAnswer(gmail[1] ?? '', gmail[2] ?? null);
	}
	if (method === 'POST' && path === '/upload/drive/v3/files') {
		const {name, mimeType, parents} = JSON.parse(request.body.toString());
		generated += 1;
		return openSession({fileId: `1Made${generated}`, create: {name, mimeType, parents}});
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

// Every request goes to Google.
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

beforeEach(() => {
	state = fresh();
	google.requests = [];
});

describe.skipIf(!databaseUrl)('blobs into and out of Google Drive', () => {
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

	// A blob of the agent's, of `bytes`, called what `name` says.
	async function blobOf(bytes: string, name: string | null, type: string | null = null): Promise<string> {
		const {storeBlob} = await import('../blobs/blobs');
		const {streamOf} = await import('../native/files/content');
		return unwrap(await storeBlob({orgId, agentId}, {name, type}, streamOf(Buffer.from(bytes)))).id;
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
		const user = await db.user.create({data: {email: `drive-blobs-test-${stamp}@example.test`, name: 'Dana'}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Drive blobs test', slug: `drive-blobs-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		const made = await db.connection.create({data: {orgId, integrationId: 'google', account: 'dana@example.com', ownerUserId: userId, credential: `enc:${JSON.stringify(CREDENTIAL)}`}});
		connection = {id: made.id, orgId, credential: made.credential ?? ''};
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `drive-blobs-test-${stamp}`, passwordHash: ''}})).id;
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

	test('a new file is made of a blob in one go, its bytes streamed to Drive, and logged as the agent’s', async () => {
		const bytes = '%PDF results';
		const blob = await blobOf(bytes, 'results.pdf');
		const added = unwrap(await tool('files_upload', {blob, name: 'Results.pdf', parent: 'drive-0ATeamDrive'}));

		expect(added).toBe(['Added Results.pdf.', 'Id: 1Made1', 'Version: 1Made1-r1', 'Size: 12 B', 'Link: https://drive.google.com/open?id=1Made1'].join('\n'));
		const [start, sent] = uploadsToDrive();
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({name: 'Results.pdf', mimeType: 'application/pdf', parents: ['0ATeamDrive']});
		expect([start?.headers['x-upload-content-length'], start?.headers['x-upload-content-type']]).toEqual([String(bytes.length), 'application/pdf']);
		expect(sent?.body.toString()).toBe(bytes);
		expect(state.files['1Made1']?.parents).toEqual(['0ATeamDrive']);
		expect((await changesOf('1Made1')).map((change) => [change.kind, change.afterRevision, change.taskId])).toEqual([['create', '1Made1-r1', taskId]]);
	});

	test('an email’s attachment is made a blob and put in Drive, under the name it came with', async () => {
		const {gmailAttachmentsConnector} = await import('./google-emails');
		const {findIntegration} = await import('@proxy/integrations');
		const collection = findIntegration('google')?.collections.find((one) => one.id === 'attachments');
		if (!collection) {
			throw new Error('no attachments collection');
		}
		const target = {connection: {...connection, integrationId: 'google'} as never, collection, by: {agentId, taskId}};
		const record = unwrap(await gmailAttachmentsConnector.newCommands.blob(target, {email: EMAIL.id, attachment: '1'}));
		expect(record?.values).toMatchObject({email: EMAIL.id, attachment: '1', name: 'Signed contract.pdf', type: 'application/pdf', size: '20 B'});
		const blob = record?.values.blob ?? '';

		// Only an agent's run makes one, as only an agent uses it.
		expect(refusal(await gmailAttachmentsConnector.newCommands.blob({...target, by: {userId}}, {email: EMAIL.id, attachment: '1'}))).toBe(
			'validation_error: A blob is an agent’s: only an agent makes one',
		);

		google.requests = [];
		const added = unwrap(await tool('files_upload', {blob, parent: '1Projects'}));
		expect(added).toStartWith('Added Signed contract.pdf.');
		const id = lineOf(added, 'Id');
		expect(state.files[id]).toMatchObject({name: 'Signed contract.pdf', mimeType: 'application/pdf', parents: ['1Projects']});
		expect(state.files[id]?.revisions[0]?.bytes.toString()).toBe(EMAIL.bytes);
	});

	test('with convert, a docx becomes a Doc named without its extension', async () => {
		const blob = await blobOf('docx 9 b.', 'Q3 review.docx');
		const added = unwrap(await tool('files_upload', {blob, parent: '1Projects', convert: true}));
		const [start] = uploadsToDrive();
		expect(JSON.parse(start?.body.toString() ?? '{}')).toEqual({name: 'Q3 review', mimeType: MIME.document, parents: ['1Projects']});
		expect(start?.headers['x-upload-content-type']).toBe(MIME.docx);
		const id = lineOf(added, 'Id');
		expect(lineOf(added, 'Version')).toBe('1');
		expect(state.files[id]?.mimeType).toBe(MIME.document);
		expect((await changesOf(id)).map((change) => change.kind)).toEqual(['create']);
	});

	test('over a file, the version read is checked, the task’s copy kept, the bytes sent and the write logged between Drive’s revisions', async () => {
		const bytes = '%PDF second draft';
		const blob = await blobOf(bytes, null);
		expect(refusal(await tool('files_upload', {blob, id: '1Contract', version: '1Contract-r0'}))).toBe(
			'conflict: “Contract.pdf” changed since version 1Contract-r0: it is at 1Contract-r1 now. Look at it again, then put what you make of it in Drive with the version files_versions says it is at.',
		);
		expect(uploadsToDrive()).toEqual([]);

		google.requests = [];
		const wrote = unwrap(await tool('files_upload', {blob, id: 'https://drive.google.com/file/d/1Contract/view', version: '1Contract-r1'}));
		expect(wrote).toStartWith('Wrote Contract.pdf. The version before is kept.\nId: 1Contract\nVersion: 1Contract-r2');
		const download = asked().indexOf('GET /drive/v3/files/1Contract?alt=media');
		expect(download).toBeGreaterThan(-1);
		expect(asked().indexOf('PATCH /upload/drive/v3/files/1Contract')).toBeGreaterThan(download);
		// A blob that says nothing of its type keeps the file's own.
		expect(uploadsToDrive()[0]?.headers['x-upload-content-type']).toBe('application/pdf');
		expect(state.files['1Contract']?.revisions.at(-1)?.bytes.toString()).toBe(bytes);
		const [copy] = await versionsOf('1Contract');
		expect(copy).toMatchObject({sourceRevision: '1Contract-r1', type: 'application/pdf'});
		expect((await changesOf('1Contract')).map((change) => [change.kind, change.beforeVersion, change.beforeRevision, change.afterRevision])).toEqual([
			['write', copy?.id ?? null, '1Contract-r1', '1Contract-r2'],
		]);
	});

	test('Markdown goes over a file of its own bytes as any bytes do, a notes.md written over with a newer one', async () => {
		const blob = await blobOf('# Notes!', 'notes.md', 'text/markdown');
		unwrap(await tool('files_upload', {blob, id: '1Notes', version: '1Notes-r1'}));

		const [session] = uploadsToDrive();
		expect([session?.method, session?.url.pathname, session?.headers['x-upload-content-type']]).toEqual(['PATCH', '/upload/drive/v3/files/1Notes', 'text/markdown']);
		const [write] = await changesOf('1Notes');
		expect(write).toMatchObject({kind: 'write', beforeRevision: '1Notes-r1'});
	});

	test('anything over a Doc or a Sheet, Google’s types, and what convert can’t make are refused, and nothing reaches Drive', async () => {
		const pdf = await blobOf('%PDF', 'scan.pdf');
		const markdown = await blobOf('# Plan', 'plan.md', 'text/markdown');
		const csv = await blobOf('a,b', 'budget.csv', 'text/csv');
		const doc = await blobOf('doc', 'Plan', MIME.document);
		const refusals = await Promise.all([
			tool('files_upload', {blob: pdf, id: '1Plan', version: '7'}),
			tool('files_upload', {blob: markdown, id: '1Plan', version: '7'}),
			tool('files_upload', {blob: csv, id: '1Budget', version: '7'}),
			tool('files_upload', {blob: pdf, id: '1Projects', version: '7'}),
			tool('files_upload', {blob: pdf, id: '1Contract', version: '1Contract-r1', convert: true}),
			tool('files_upload', {blob: doc}),
			tool('files_upload', {blob: pdf, convert: true}),
			tool('files_upload', {blob: pdf, parent: '1Budget'}),
			tool('files_upload', {blob: pdf, parent: 'recent'}),
		]);

		expect(refusals.map(refusal)).toEqual([
			'validation_error: “Launch plan” is a Doc, which is never written over whole, since it would lose its comments, suggestions and formatting: edit its text in place with the docs_edit tool, or upload the file as a new Doc, with name, parent and convert.',
			'validation_error: “Launch plan” is a Doc, which is never written over whole, since it would lose its comments, suggestions and formatting: edit its text in place with the docs_edit tool, or upload the file as a new Doc, with name, parent and convert.',
			'validation_error: “Budget 2026” is a Sheet, which is never written over whole, since it would lose its comments, suggestions and formatting: write its cells with the ranges_write tool, and change its rows, columns and tabs with sheets_rows and sheets_tabs, or upload the file as a new Sheet, with name, parent and convert.',
			'validation_error: “Projects” is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it',
			'validation_error: convert makes a new file into a Doc, Sheet or Slides file; a file written over keeps its own kind: leave convert out',
			'validation_error: A file uploaded is its own bytes, of their own type, never one of Google’s: to make a Doc, Sheet or Slides file, upload a docx, xlsx or pptx, or Markdown or CSV, with convert',
			'validation_error: convert makes a Doc of a docx or Markdown, a Sheet of an xlsx or CSV, and a Slides file of a pptx, and this is application/pdf: leave convert out to keep it as it is',
			'validation_error: A spreadsheet holds tabs: upload the file into a folder',
			'validation_error: Nothing can be made in Recent: make it in a folder, My Drive or a shared drive',
		]);
		expect(uploadsToDrive()).toEqual([]);
	});

	test('files_blob makes a blob of a file’s bytes, now or at a revision, and of a Doc as Drive exports it', async () => {
		const {getFileBlob} = await import('@proxy/db/files');
		const {readContent} = await import('../native/files/content');
		const bytesOf = async (answer: string) => Buffer.from(unwrap(await readContent(unwrap(await getFileBlob(lineOf(answer, 'Blob'))) ?? {backendId: '', key: ''}))).toString();

		const contract = unwrap(await tool('files_blob', {id: '1Contract'}));
		expect(contract).toStartWith('Made a blob of Contract.pdf, version 1Contract-r1.');
		expect([lineOf(contract, 'Name'), lineOf(contract, 'Type')]).toEqual(['Contract.pdf', 'application/pdf']);
		expect(await bytesOf(contract)).toBe('%PDF first draft');

		const plan = unwrap(await tool('files_blob', {id: '1Plan', as: 'docx'}));
		expect(plan).toStartWith('Made a blob of Launch plan.docx, version 7, as docx.');
		expect(await bytesOf(plan)).toBe('docx of the launch plan');
		expect(refusal(await tool('files_blob', {id: '1Contract', as: 'docx'}))).toBe(
			'validation_error: “Contract.pdf” is a file of its own bytes, application/pdf, and is handed over as they are: leave as and tab out.',
		);
		expect(refusal(await tool('files_blob', {id: '1Projects'}))).toStartWith('validation_error: Projects is a folder');
	});
});
