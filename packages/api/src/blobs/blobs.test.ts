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

// Blobs, end to end, on a drive of Files: bytes PUT to the URL pap.upload() gives made a blob,
// files_upload putting a blob in the drive and files_blob making one of a file, through the gate,
// as an agent runs them, and a blob's bytes fetched from the URL pap.download(blob) gives, against
// the local database and a blob store in a temporary directory. Run with the database up
// (`bun run dev`) and the environment loaded,
// `bun --env-file=../../.env test --isolate src/blobs/blobs.test.ts` from this package. Without
// DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is skipped.
// Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const store = mkdtempSync(join(tmpdir(), 'proxy-blobs-test-'));

const APP_URL = 'https://app.example.com';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL, AUTH_SECRET: 'test-secret', FILES_DIR: store, FILES_STORE: {kind: 'disk', dir: store}, FILES_MAX_MB: 1}}));
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

describe.skipIf(!databaseUrl)('blobs, through a drive of Files', () => {
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

	function agentOf(as: string) {
		return {agentId: as, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
	}

	// A tool run as an agent runs it, through the gate, for the task.
	async function tool(name: string, params: Record<string, unknown>, as = agentId): Promise<Result<string, ApiError>> {
		const {runAgentTool} = await import('../agent-side/tools');
		const ran = await runAgentTool({agent: agentOf(as), via: 'mcp', taskId: tasks.get(as) ?? taskId}, connectionId, name, params);
		return ran.map((result) => ('text' in result && typeof result.text === 'string' ? result.text : JSON.stringify(result)));
	}

	// A `pap` function, as a script calls it.
	async function pap(method: 'upload' | 'download', args: string[], as = agentId): Promise<Record<string, string | number | null>> {
		const {agentScriptHost} = await import('../script/agent-host');
		const host = agentScriptHost(agentOf(as), {via: 'mcp', task: tasks.get(as) ?? taskId, taskTools: true, sandboxes: true});
		const answered = await host.answer(method, args);
		if (answered.isErr()) {
			throw new Error(answered.error.message);
		}
		return JSON.parse(answered.value);
	}

	// A URL of the app's, at the test's server.
	function local(url: string): string {
		return url.replace(APP_URL, origin);
	}

	// Bytes PUT to the URL pap.upload() gave, made a blob: its id.
	async function upload(body: string, name?: string, as = agentId): Promise<string> {
		const {url} = await pap('upload', [], as);
		const sent = await fetch(`${local(String(url))}${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`, {method: 'PUT', body});
		expect(sent.status).toBe(200);
		return (await sent.json()).blob;
	}

	// What the activity log holds of the drive since `since`, as [action, outcome].
	async function logged(since: Date) {
		const {db} = await import('@proxy/db');
		const entries = await db.auditEntry.findMany({where: {orgId, connectionId, createdAt: {gte: since}}, orderBy: {createdAt: 'asc'}});
		return entries.map((entry) => [entry.action, entry.outcome]);
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const user = await db.user.create({data: {email: `blobs-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Blobs test', slug: `blobs-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		await db.orgMember.create({data: {orgId, userId}});
		await db.connection.create({
			data: {orgId, integrationId: 'files', ownerUserId: userId, account: 'Drive', defaults: {create: [{actionId: 'readFiles'}, {actionId: 'createFiles'}, {actionId: 'editFiles'}]}},
		});
		connectionId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files'}})).id;
		agentId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `blobs-test-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		readerId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Reader', username: `blobs-test-reader-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		await db.agentGrant.create({data: {agentId: readerId, connectionId, actionId: 'editFiles', allowed: false}});
		otherId = (await db.agent.create({data: {orgId, providerId: 'claude', name: 'Other', username: `blobs-test-other-${stamp}`, passwordHash: '', ownerUserId: userId}})).id;
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'File the quarterly report', goal: 'A report', via: 'mcp'}})).id;
		for (const id of [readerId, otherId]) {
			tasks.set(id, (await db.agentTask.create({data: {orgId, agentId: id, title: 'Tidy the drive', goal: 'A tidy drive', via: 'mcp'}})).id);
		}

		const {BLOBS_PATH} = await import('@proxy/contracts/blobs');
		const {allowAnyOrigin} = await import('../server/middleware/allow-any-origin');
		const {handleBlobGetRoute, handleBlobPutRoute} = await import('./route');
		const app = express();
		app.use(BLOBS_PATH, allowAnyOrigin);
		app.put(`${BLOBS_PATH}/:token`, (request, response) => void handleBlobPutRoute(request, response));
		app.get(`${BLOBS_PATH}/:token`, (request, response) => void handleBlobGetRoute(request, response));
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

	test('makes a blob of bytes PUT to the URL pap.upload() gives, and puts it in the drive as the agent’s for its task', async () => {
		const since = new Date();
		const content = '%PDF-1.7 a quarterly report';
		const {url, method} = await pap('upload', []);
		expect(String(url)).toStartWith(`${APP_URL}/api/blobs/blob_`);
		expect(method).toBe('PUT');

		const sent = await fetch(`${local(String(url))}?name=report.pdf`, {method: 'PUT', body: content});
		expect(sent.status).toBe(200);
		expect(sent.headers.get('access-control-allow-origin')).toBe('*');
		const stored = await sent.json();
		expect(stored).toEqual({blob: stored.blob, name: 'report.pdf', size: content.length, sha256: sha256(content)});
		const {db} = await import('@proxy/db');
		expect(await db.fileBlob.findUniqueOrThrow({where: {id: stored.blob}})).toMatchObject({orgId, agentId, name: 'report.pdf', size: content.length});

		// Named as the blob is, where the call names nothing.
		const added = unwrap(await tool('files_upload', {blob: stored.blob}));
		expect(added).toStartWith('Added report.pdf.');
		const id = lineOf(added, 'Id');
		expect(lineOf(added, 'Link')).toBe(`${APP_URL}/acme/connections/${connectionId}?file=${id}`);

		const read = unwrap(await tool('files_read', {id}));
		expect(lineOf(read, 'Type')).toBe('application/pdf');
		expect(lineOf(read, 'Version')).toBe(lineOf(added, 'Version'));
		const change = await db.fileChange.findFirstOrThrow({where: {connectionId, fileId: id}});
		expect(change).toMatchObject({kind: 'create', agentId, taskId, userId: null, afterVersion: lineOf(added, 'Version')});
		// The file holds the very blob that arrived.
		expect((await db.fileVersion.findUniqueOrThrow({where: {id: lineOf(added, 'Version')}})).blobId).toBe(stored.blob);
		expect(await logged(since)).toEqual([
			['files_upload', 'allowed'],
			['files_read', 'allowed'],
		]);
	});

	test('writes a blob over a file by whoever names the version it holds, and refuses one that moved on', async () => {
		const made = unwrap(await tool('files_create', {name: 'notes.txt', content: 'first'}));
		const id = lineOf(made, 'Id');
		const first = lineOf(made, 'Version');
		const second = await upload('second');

		expect(refusal(await tool('files_upload', {blob: second, id, version: 'not-the-version'}))).toStartWith('conflict');
		expect(refusal(await tool('files_upload', {blob: second, id}))).toStartWith('validation_error: To write over a file, give the version you read too');
		expect(refusal(await tool('files_upload', {blob: second, id, version: first, name: 'other.txt'}))).toStartWith('validation_error: files_upload writes over the file id names');
		// Files keeps every file as its bytes: nothing is converted, new or written over.
		expect(refusal(await tool('files_upload', {blob: second, name: 'notes.docx', convert: true}))).toBe('validation_error: Files keeps every file as its bytes, of its own type: leave convert out');
		expect(refusal(await tool('files_upload', {blob: second, id, version: first, convert: true}))).toStartWith('validation_error: convert makes a new file into a Doc, Sheet or Slides file');

		const wrote = unwrap(await tool('files_upload', {blob: second, id, version: first}));
		expect(wrote).toStartWith('Wrote notes.txt. The version before is kept.');
		expect(lineOf(wrote, 'Id')).toBe(id);
		expect(unwrap(await tool('files_read', {id}))).toEndWith('\n\nsecond');
		expect(unwrap(await tool('files_versions', {id}))).toContain('notes.txt has 2 versions');
	});

	test('refuses what can’t be made, where it goes', async () => {
		const folder = lineOf(unwrap(await tool('files_create', {name: 'Reports', folder: true})), 'Id');
		unwrap(await tool('files_create', {name: 'taken.txt', parent: folder, content: 'x'}));
		const blob = await upload('y');

		expect(refusal(await tool('files_upload', {blob}))).toBe('validation_error: This blob has no name of its own: give the new file’s name, with its extension, as report.pdf');
		expect(refusal(await tool('files_upload', {blob, name: 'taken.txt', parent: folder}))).toBe('conflict: Something is already called taken.txt there.');
		expect(refusal(await tool('files_upload', {blob, id: folder, version: 'v'}))).toStartWith('validation_error: Reports is a folder');
		expect(refusal(await tool('files_upload', {blob, name: 'a/b.txt'}))).toStartWith('validation_error');
		expect(refusal(await tool('files_upload', {name: 'c.txt'}))).toStartWith('validation_error: files_upload takes blob');
		expect(refusal(await tool('files_upload', {blob: 'no-such-blob', name: 'c.txt'}))).toStartWith('not_found: There is no blob no-such-blob of yours.');
	});

	test('makes a blob of a file, and hands its bytes over at the URL pap.download(blob) gives', async () => {
		const since = new Date();
		const made = unwrap(await tool('files_create', {name: 'plan.md', content: '# Plan'}));
		const id = lineOf(made, 'Id');
		const first = lineOf(made, 'Version');
		unwrap(await tool('files_write', {id, version: first, content: '# Plan, again'}));

		const now = unwrap(await tool('files_blob', {id}));
		expect(now).toStartWith('Made a blob of plan.md, version ');
		expect(lineOf(now, 'Name')).toBe('plan.md');
		expect(lineOf(now, 'Type')).toBe('text/markdown');
		const before = unwrap(await tool('files_blob', {id, version: first}));
		expect(refusal(await tool('files_blob', {id, as: 'pdf'}))).toStartWith('validation_error: Files keeps every file as its bytes');

		const download = await pap('download', [lineOf(before, 'Blob')]);
		expect(download).toMatchObject({blob: lineOf(before, 'Blob'), name: 'plan.md', type: 'text/markdown', size: 6});
		const fetched = await fetch(local(String(download.url)));
		expect(fetched.status).toBe(200);
		expect(fetched.headers.get('content-type')).toStartWith('text/markdown');
		expect(fetched.headers.get('content-disposition')).toContain('filename="plan.md"');
		// Never a page of the app's, whatever the blob holds.
		expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
		expect(fetched.headers.get('content-security-policy')).toStartWith('sandbox');
		expect(await fetched.text()).toBe('# Plan');

		// A blob of one file, put in the drive as another.
		const copied = unwrap(await tool('files_upload', {blob: lineOf(now, 'Blob'), name: 'plan copy.md'}));
		expect(unwrap(await tool('files_read', {id: lineOf(copied, 'Id')}))).toEndWith('\n\n# Plan, again');
		expect(await logged(since)).toEqual([
			['files_create', 'allowed'],
			['files_write', 'allowed'],
			['files_blob', 'allowed'],
			['files_blob', 'allowed'],
			['files_blob', 'failed'],
			['files_upload', 'allowed'],
			['files_read', 'allowed'],
		]);
	});

	test('keeps a blob to the agent that made it, and asks each run for the action it needs', async () => {
		const made = unwrap(await tool('files_create', {name: 'guarded.txt', content: 'x'}));
		const id = lineOf(made, 'Id');
		const version = lineOf(made, 'Version');
		const mine = await upload('mine', 'mine.txt');

		// Another agent can't use it, nor fetch it.
		expect(refusal(await tool('files_upload', {blob: mine}, otherId))).toStartWith(`not_found: There is no blob ${mine} of yours.`);
		await expect(pap('download', [mine], otherId)).rejects.toThrow(`There is no blob ${mine} of yours.`);

		// The reader may add files but not write over them.
		const readers = await upload('r', 'readers.txt', readerId);
		expect(refusal(await tool('files_upload', {blob: readers, id, version}, readerId))).toBe('forbidden');
		expect(unwrap(await tool('files_upload', {blob: readers}, readerId))).toStartWith('Added readers.txt.');
	});

	test('hands a blob over to attach to an email, to the agent that made it alone', async () => {
		const {attachedBlobs} = await import('../records/email-attachments');
		const {loadRunTarget} = await import('../agent-side/tools');
		const {findCollection, findIntegration} = await import('@proxy/integrations');
		const email = findIntegration('email');
		const collection = email && findCollection(email, 'emails');
		if (!collection) {
			throw new Error('No emails collection');
		}
		// Whose blobs they are is the agent's alone, whatever the connection the email is written on.
		const {connection} = unwrap(await loadRunTarget({agent: agentOf(agentId), via: 'mcp', taskId}, connectionId));
		const as = (agent: string) => ({connection, collection, by: {agentId: agent, taskId}});
		const offer = await upload('%PDF offer', 'offer.pdf');

		expect(unwrap(await attachedBlobs(as(agentId), offer))).toEqual([{filename: 'offer.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF offer')}]);
		expect(refusal(await attachedBlobs(as(otherId), offer))).toStartWith(`not_found: There is no blob ${offer} of yours.`);
	});

	test('refuses more bytes than a file may be as they come, and URLs that aren’t, or have run out', async () => {
		const {url} = await pap('upload', []);
		const over = await fetch(local(String(url)), {method: 'PUT', body: 'x'.repeat(1024 * 1024 + 1)});
		expect(over.status).toBe(413);
		expect((await over.json()).error).toBe('too_large');

		const forged = await fetch(`${origin}/api/blobs/blob_e30.c2ln`, {method: 'PUT', body: 'x'});
		expect(forged.status).toBe(403);

		const {blobUploadUrl, blobDownloadUrl} = await import('./blobs');
		const hourAgo = new Date(Date.now() - 60 * 60_000 - 1000);
		const late = unwrap(blobUploadUrl({orgId, agentId}, hourAgo));
		expect((await fetch(local(late.url), {method: 'PUT', body: 'x'})).status).toBe(410);
		// An agent that is gone moves nothing more.
		const gone = unwrap(blobUploadUrl({orgId, agentId: 'no-such-agent'}));
		expect((await fetch(local(gone.url), {method: 'PUT', body: 'x'})).status).toBe(403);

		// A URL to PUT reads nothing, and one to GET takes nothing.
		const blob = await upload('kept');
		const download = unwrap(await blobDownloadUrl({orgId, agentId}, blob));
		expect((await fetch(local(download.url), {method: 'PUT', body: 'x'})).status).toBe(403);
		expect((await fetch(local(String(url)))).status).toBe(403);
	});

	test('refuses a blob past its day, which the sweep takes', async () => {
		const {db} = await import('@proxy/db');
		const blob = await upload('old', 'old.txt');
		await db.fileBlob.update({where: {id: blob}, data: {createdAt: new Date(Date.now() - 23 * 60 * 60_000 - 1000)}});
		expect(refusal(await tool('files_upload', {blob}))).toBe(`not_found: Blob ${blob} is gone: a blob is kept for a day. Make it again from where the file is.`);
	});
});
