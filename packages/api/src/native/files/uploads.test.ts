import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import express from 'express';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// Uploads into a drive of Files through a URL, end to end: files_upload and files_upload_done
// through the gate, as an agent runs them, and the bytes PUT over HTTP to the URL, against the
// local database and a blob store in a temporary directory. Run with the database up
// (`bun run dev`) and the environment loaded,
// `bun --env-file=../../.env test --isolate src/native/files/uploads.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-files-uploads-test-'));

const APP_URL = 'https://app.example.com';

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL, FILES_DIR: blobs, FILES_MAX_MB: 1}}));
mock.module('../../observability/log', () => ({
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

// What an answer says on the line that starts with `label`.
function lineOf(answer: string, label: string): string {
	return (
		answer
			.split('\n')
			.find((line) => line.startsWith(`${label}: `))
			?.slice(label.length + 2) ?? ''
	);
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

describe.skipIf(!databaseUrl)('uploads into a drive, through a URL', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let taskId = '';
	let agentId = '';
	// An agent that was told it may not write over files, and one other agent.
	let readerId = '';
	let otherId = '';
	// Each agent's task but the first's, which is `taskId`.
	const tasks = new Map<string, string>();
	let server: Server | null = null;
	let origin = '';

	// A tool run as an agent runs it, through the gate, for the task.
	async function tool(name: string, params: Record<string, unknown>, as = agentId): Promise<Result<string, ApiError>> {
		const {runAgentTool} = await import('../../agent-side/tools');
		const agent = {agentId: as, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
		const ran = await runAgentTool({agent, via: 'mcp', taskId: tasks.get(as) ?? taskId}, connectionId, name, params);
		return ran.map((result) => ('text' in result && typeof result.text === 'string' ? result.text : JSON.stringify(result)));
	}

	// The bytes sent to an upload's URL, at the test's server rather than the app's.
	function put(url: string, body: string, init: RequestInit = {}): Promise<Response> {
		return fetch(url.replace(APP_URL, origin), {method: 'PUT', body, ...init});
	}

	async function uploadOf(id: string) {
		const {db} = await import('@proxy/db');
		return db.fileUpload.findUniqueOrThrow({where: {id}});
	}

	// What the activity log holds of the drive since `since`, as [action, outcome].
	async function logged(since: Date) {
		const {db} = await import('@proxy/db');
		const entries = await db.auditEntry.findMany({where: {orgId, connectionId, createdAt: {gte: since}}, orderBy: {createdAt: 'asc'}});
		return entries.map((entry) => [entry.action, entry.outcome]);
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const {createMissingFilesConnection} = await import('@proxy/db/files');
		const user = await db.user.create({data: {email: `files-uploads-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Files uploads test', slug: `files-uploads-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		await db.orgMember.create({data: {orgId, userId}});
		unwrap(await createMissingFilesConnection({orgId, userId, integrationId: 'files', defaults: ['readFiles', 'createFiles', 'editFiles']}));
		connectionId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files'}})).id;
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `files-uploads-test-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		readerId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Reader', username: `files-uploads-test-reader-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		await db.agentGrant.create({data: {agentId: readerId, connectionId, actionId: 'editFiles', allowed: false}});
		otherId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Other', username: `files-uploads-test-other-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'File the quarterly report', goal: 'A report', via: 'mcp'}})).id;
		for (const id of [readerId, otherId]) {
			tasks.set(id, (await db.agentTask.create({data: {orgId, agentId: id, title: 'Tidy the drive', goal: 'A tidy drive', via: 'mcp'}})).id);
		}

		const {UPLOADS_PATH} = await import('@proxy/contracts/uploads');
		const {allowAnyOrigin} = await import('../../server/middleware/allow-any-origin');
		const {handleUploadBytesRoute} = await import('./upload-route');
		const app = express();
		app.use(UPLOADS_PATH, allowAnyOrigin);
		app.put(`${UPLOADS_PATH}/:secret`, (request, response) => void handleUploadBytesRoute(request, response));
		server = app.listen(0);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server?.close();
		const {db} = await import('@proxy/db');
		if (orgId !== '') {
			await db.auditEntry.deleteMany({where: {orgId}});
			await db.fileUpload.deleteMany({where: {orgId}});
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('adds a file from bytes PUT to the URL, once done says so, as the agent’s for its task', async () => {
		const since = new Date();
		const content = '%PDF-1.7 a quarterly report';
		const started = unwrap(await tool('files_upload', {name: 'report.pdf', size: content.length, sha256: sha256(content)}));
		const upload = lineOf(started, 'Upload');
		const url = lineOf(started, 'URL');

		expect(url).toStartWith(`${APP_URL}/api/uploads/`);
		expect(lineOf(started, 'Method')).toBe('PUT');
		expect(lineOf(started, 'Headers')).toBe('none needed');
		expect(started).toContain(`\ncurl -X PUT --upload-file <path> '${url}'\n`);
		expect(started).toContain(`files_upload_done with upload ${upload}`);
		// The secret is kept only as its hash, and the upload points at the log entry of the call that started it.
		const row = await uploadOf(upload);
		const secret = url.slice(url.lastIndexOf('/') + 1);
		expect(row.secretHash).toBe(sha256(secret));
		expect(Object.values(row).filter((value) => typeof value === 'string' && value.includes(secret))).toEqual([]);
		const {db} = await import('@proxy/db');
		expect((await db.auditEntry.findUniqueOrThrow({where: {id: row.entryId ?? ''}})).action).toBe('files_upload');

		// Before the bytes, done has nothing to make.
		expect(refusal(await tool('files_upload_done', {upload}))).toStartWith(`validation_error: Nothing has arrived for upload ${upload} yet`);

		const sent = await put(url, content);
		expect(sent.status).toBe(200);
		expect(sent.headers.get('access-control-allow-origin')).toBe('*');
		expect(await sent.json()).toEqual({upload, size: content.length, sha256: sha256(content), next: `Call files_upload_done with upload ${upload} to make the file.`});

		const done = unwrap(await tool('files_upload_done', {upload}));
		expect(done).toStartWith('Added report.pdf.');
		const id = lineOf(done, 'Id');
		expect(lineOf(done, 'Link')).toBe(`${APP_URL}/acme/connections/${connectionId}?file=${id}`);
		// Asked again, it answers the same.
		expect(unwrap(await tool('files_upload_done', {upload}))).toBe(done);

		const read = unwrap(await tool('files_read', {id}));
		expect(lineOf(read, 'Type')).toBe('application/pdf');
		expect(lineOf(read, 'Version')).toBe(lineOf(done, 'Version'));
		const change = await db.fileChange.findFirstOrThrow({where: {connectionId, fileId: id}});
		expect(change).toMatchObject({kind: 'create', agentId, taskId, userId: null, afterVersion: lineOf(done, 'Version')});
		expect(await logged(since)).toEqual([
			['files_upload', 'allowed'],
			['files_upload_done', 'failed'],
			['files_upload_done', 'allowed'],
			['files_upload_done', 'allowed'],
			['files_read', 'allowed'],
		]);
	});

	test('writes over a file by whoever names the version it holds, and refuses one that moved on', async () => {
		const made = unwrap(await tool('files_create', {name: 'notes.txt', content: 'first'}));
		const id = lineOf(made, 'Id');
		const first = lineOf(made, 'Version');

		expect(refusal(await tool('files_upload', {id, version: 'not-the-version', size: 6}))).toBe(
			`conflict: notes.txt changed since that version was read: it holds ${first} now. Read it again with files_read, then upload what you make of it.`,
		);
		expect(refusal(await tool('files_upload', {id, size: 6}))).toStartWith('validation_error: To write over a file, give the version you read too');
		// Files keeps every file as its bytes: nothing is converted, new or written over.
		expect(refusal(await tool('files_upload', {name: 'notes.docx', size: 6, convert: true}))).toBe('validation_error: Files keeps every file as its bytes, of its own type: leave convert out');
		expect(refusal(await tool('files_upload', {id, version: first, size: 6, convert: true}))).toStartWith('validation_error: convert makes a new file into a Doc, Sheet or Slides file');

		const started = unwrap(await tool('files_upload', {id, version: first, size: 6}));
		expect((await put(lineOf(started, 'URL'), 'second')).status).toBe(200);
		const done = unwrap(await tool('files_upload_done', {upload: lineOf(started, 'Upload')}));
		expect(done).toStartWith('Wrote notes.txt. The version before is kept.');
		const second = lineOf(done, 'Version');
		expect(lineOf(done, 'Id')).toBe(id);
		expect(unwrap(await tool('files_read', {id}))).toEndWith('\n\nsecond');

		// A file changed between the start and done is not written over, and done says so every time.
		const late = unwrap(await tool('files_upload', {id, version: second, size: 5}));
		unwrap(await tool('files_write', {id, version: second, content: 'third'}));
		expect((await put(lineOf(late, 'URL'), 'fifth')).status).toBe(200);
		const lost = refusal(await tool('files_upload_done', {upload: lineOf(late, 'Upload')}));
		expect(lost).toStartWith('conflict: The file changed since that version was read.');
		expect(refusal(await tool('files_upload_done', {upload: lineOf(late, 'Upload')}))).toBe(lost);
		expect((await uploadOf(lineOf(late, 'Upload'))).status).toBe('failed');
		expect(unwrap(await tool('files_read', {id}))).toEndWith('\n\nthird');
	});

	test('checks everything before a URL is handed out', async () => {
		const folder = lineOf(unwrap(await tool('files_create', {name: 'Reports', folder: true})), 'Id');
		const file = lineOf(unwrap(await tool('files_create', {name: 'taken.txt', parent: folder, content: 'x'})), 'Id');

		expect(refusal(await tool('files_upload', {name: 'big.bin', size: 1024 * 1024 + 1}))).toBe('validation_error: A file is at most 1.0 MB on this server, 1048576 bytes, and this one is 1048577.');
		expect(refusal(await tool('files_upload', {name: 'taken.txt', parent: folder, size: 1}))).toBe('conflict: Something is already called taken.txt there.');
		expect(refusal(await tool('files_upload', {name: 'inside.txt', parent: file, size: 1}))).toStartWith('not_found');
		expect(refusal(await tool('files_upload', {id: folder, version: 'v', size: 1}))).toStartWith('validation_error: Reports is a folder');
		expect(refusal(await tool('files_upload', {name: 'a/b.txt', size: 1}))).toStartWith('validation_error');
		expect(refusal(await tool('files_upload', {name: 'c.txt', size: 1, sha256: 'abc'}))).toStartWith('validation_error: files_upload takes size');
		expect(refusal(await tool('files_upload', {name: 'c.txt', size: -1}))).toStartWith('validation_error: files_upload takes size');
		expect(refusal(await tool('files_upload_done', {upload: 'no-such-upload'}))).toBe('not_found: There is no upload no-such-upload of yours on this drive: files_upload starts one.');
	});

	test('takes one PUT, refusing more bytes than were said as they come, and another once the bytes are in', async () => {
		const started = unwrap(await tool('files_upload', {name: 'one.txt', size: 3}));
		const url = lineOf(started, 'URL');
		const upload = lineOf(started, 'Upload');

		const over = await put(url, 'four');
		expect(over.status).toBe(413);
		expect((await over.json()).error).toBe('too_large');
		// One that failed may be sent again.
		expect((await put(url, 'one')).status).toBe(200);
		const again = await put(url, 'one');
		expect(again.status).toBe(409);
		expect((await again.json()).message).toStartWith(`The file for upload ${upload} arrived already, and a URL takes one.`);
		unwrap(await tool('files_upload_done', {upload}));
		expect((await put(url, 'one')).status).toBe(409);

		const unknown = await put(`${APP_URL}/api/uploads/not-a-secret`, 'x');
		expect(unknown.status).toBe(404);
	});

	test('makes nothing of bytes that are not what was said', async () => {
		const short = unwrap(await tool('files_upload', {name: 'short.txt', size: 10}));
		expect((await put(lineOf(short, 'URL'), 'five5')).status).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(short, 'Upload')}))).toBe(
			'conflict: short.txt was to be 10 bytes, and 5 arrived, so nothing was made of it. Start again with files_upload, with the file’s size in bytes, as wc -c < <path> counts it.',
		);

		const wrong = unwrap(await tool('files_upload', {name: 'hashed.txt', size: 5, sha256: sha256('right')}));
		expect((await put(lineOf(wrong, 'URL'), 'wrong')).status).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(wrong, 'Upload')}))).toStartWith(
			`conflict: The bytes that arrived for hashed.txt have the SHA-256 ${sha256('wrong')}, not the ${sha256('right')} given`,
		);

		const {db} = await import('@proxy/db');
		expect(await db.fileNode.findMany({where: {connectionId, name: {in: ['short.txt', 'hashed.txt']}}})).toEqual([]);
	});

	test('takes nothing after its hour, and the sweep lets go of what nobody finished', async () => {
		const {db} = await import('@proxy/db');
		const {sweepUploads} = await import('../../uploads/sweeper');
		const hourAgo = new Date(Date.now() - 60 * 60_000 - 1000);

		const late = unwrap(await tool('files_upload', {name: 'late.txt', size: 4}));
		await db.fileUpload.update({where: {id: lineOf(late, 'Upload')}, data: {expiresAt: new Date(Date.now() - 1000)}});
		const refused = await put(lineOf(late, 'URL'), 'late');
		expect(refused.status).toBe(410);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(late, 'Upload')}))).toStartWith('conflict: This upload expired');
		expect((await uploadOf(lineOf(late, 'Upload'))).status).toBe('expired');

		// Bytes in but not finished: done may still finish it for an hour past its own, and the sweep takes it after.
		const kept = unwrap(await tool('files_upload', {name: 'kept.txt', size: 4}));
		expect((await put(lineOf(kept, 'URL'), 'kept')).status).toBe(200);
		const idle = unwrap(await tool('files_upload', {name: 'idle.txt', size: 4}));
		const forgotten = unwrap(await tool('files_upload', {name: 'forgotten.txt', size: 4}));
		expect((await put(lineOf(forgotten, 'URL'), 'gone')).status).toBe(200);
		await db.fileUpload.update({where: {id: lineOf(kept, 'Upload')}, data: {expiresAt: new Date(Date.now() - 1000)}});
		await db.fileUpload.update({where: {id: lineOf(idle, 'Upload')}, data: {expiresAt: new Date(Date.now() - 1000)}});
		await db.fileUpload.update({where: {id: lineOf(forgotten, 'Upload')}, data: {expiresAt: hourAgo}});

		await sweepUploads();
		expect((await uploadOf(lineOf(kept, 'Upload'))).status).toBe('open');
		expect((await uploadOf(lineOf(idle, 'Upload'))).status).toBe('expired');
		expect((await uploadOf(lineOf(forgotten, 'Upload'))).status).toBe('expired');
		expect(unwrap(await tool('files_upload_done', {upload: lineOf(kept, 'Upload')}))).toStartWith('Added kept.txt.');
	});

	test('asks each run for the action it needs, and keeps an upload to the agent that started it', async () => {
		const since = new Date();
		const made = unwrap(await tool('files_create', {name: 'guarded.txt', content: 'x'}));
		const id = lineOf(made, 'Id');
		const version = lineOf(made, 'Version');

		// The reader may add files but not write over them.
		expect(refusal(await tool('files_upload', {id, version, size: 1}, readerId))).toBe('forbidden');
		const added = unwrap(await tool('files_upload', {name: 'readers.txt', size: 1}, readerId));
		expect((await put(lineOf(added, 'URL'), 'r')).status).toBe(200);
		expect(unwrap(await tool('files_upload_done', {upload: lineOf(added, 'Upload')}, readerId))).toStartWith('Added readers.txt.');

		// A write started by the agent that may is not the reader's to finish, nor another agent's.
		const write = unwrap(await tool('files_upload', {id, version, size: 1}));
		expect((await put(lineOf(write, 'URL'), 'y')).status).toBe(200);
		expect(refusal(await tool('files_upload_done', {upload: lineOf(write, 'Upload')}, readerId))).toBe('forbidden');
		expect(refusal(await tool('files_upload_done', {upload: lineOf(write, 'Upload')}, otherId))).toStartWith('not_found');
		expect(unwrap(await tool('files_upload_done', {upload: lineOf(write, 'Upload')}))).toStartWith('Wrote guarded.txt.');

		expect(await logged(since)).toEqual([
			['files_create', 'allowed'],
			['files_upload', 'denied'],
			['files_upload', 'allowed'],
			['files_upload_done', 'allowed'],
			['files_upload', 'allowed'],
			['files_upload_done', 'denied'],
			['files_upload_done', 'failed'],
			['files_upload_done', 'allowed'],
		]);
	});
});
