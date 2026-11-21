import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import express from 'express';

import type {CliRequest} from '../../server/middleware/require-cli';

// A drive as code in a sandbox reaches it with `pap files`, end to end: its routes over HTTP, a
// push putting a blob of the agent's in the drive by path, as the token's agent and task, against
// the local database and a blob store in a temporary directory. Run with the database up (`bun run dev`) and the environment loaded,
// `bun --env-file=../../.env test --isolate src/native/files/cli.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-files-cli-test-'));

const APP_URL = 'https://app.example.com';

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL, FILES_DIR: blobs, FILES_STORE: {kind: 'disk', dir: blobs}, FILES_MAX_MB: 1}}));
mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

describe.skipIf(!databaseUrl)('pap files, as a sandbox reaches a drive', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let vaultId = '';
	let taskId = '';
	// One agent that may do everything the drive's defaults allow, and one that was told it may
	// not write over files.
	let agentId = '';
	let readerId = '';
	// An agent that may not read the drive, and so may not change it either.
	let strangerId = '';
	let server: Server | null = null;
	let origin = '';

	// A request as `pap` sends it, as one of the agents.
	function pap(path: string, init: RequestInit & {as?: string} = {}): Promise<Response> {
		const {as = agentId, ...rest} = init;
		return fetch(`${origin}${path}`, {...rest, headers: {...rest.headers, 'x-test-agent': as}});
	}

	// A blob of the agent's, as `pap upload` makes one.
	async function blobOf(content: string, as = agentId): Promise<string> {
		const {storeBlob} = await import('../../blobs/blobs');
		const {streamOf} = await import('./content');
		const stored = await storeBlob({orgId, agentId: as}, {name: null, type: null}, streamOf(Buffer.from(content)));
		if (stored.isErr()) {
			throw new Error(JSON.stringify(stored.error));
		}
		return stored.value.id;
	}

	// A push as `pap files push` makes it: the file made a blob, and the blob put at the path.
	async function push(path: string, content: string, query: Record<string, string> = {}, as?: string): Promise<Response> {
		const blob = await blobOf(content, as);
		return pap(`/files/${connectionId}/push?${new URLSearchParams({blob, path, ...query}).toString()}`, {method: 'POST', as});
	}

	// A push asked about before its bytes are sent, as `pap files push` asks: answered with what was said, as [status, error, message].
	async function check(path: string, query: Record<string, string> = {}, as?: string): Promise<[number, string | undefined, string | undefined]> {
		const asked = new URLSearchParams({file: path.split('/').at(-1) ?? '', size: '5', path, ...query});
		const response = await pap(`/files/${connectionId}/push/check?${asked.toString()}`, {method: 'POST', as});
		const body = await response.json();
		return [response.status, body.error, body.message];
	}

	function pull(query: Record<string, string>, as?: string): Promise<Response> {
		return pap(`/files/${connectionId}/content?${new URLSearchParams(query).toString()}`, {as});
	}

	// Which file a pull's bytes are, as its header says.
	function saidOf(response: Response) {
		return JSON.parse(decodeURIComponent(response.headers.get('x-pap-file') ?? 'null'));
	}

	// What the activity log holds of the drive, oldest first, as [action, outcome, via].
	async function logged() {
		const {db} = await import('@proxy/db');
		const entries = await db.auditEntry.findMany({where: {orgId, connectionId}, orderBy: {createdAt: 'asc'}});
		return entries.map((entry) => [entry.action, entry.outcome, entry.via]);
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const user = await db.user.create({data: {email: `files-cli-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Files cli test', slug: `files-cli-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		await db.orgMember.create({data: {orgId, userId}});
		await db.connection.create({
			data: {orgId, integrationId: 'files', ownerUserId: userId, account: 'Drive', defaults: {create: [{actionId: 'readFiles'}, {actionId: 'createFiles'}, {actionId: 'editFiles'}]}},
		});
		connectionId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files'}})).id;
		vaultId = (await db.connection.create({data: {orgId, integrationId: 'vault', account: 'Vault', credential: null, ownerUserId: userId}})).id;
		const agent = await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `files-cli-test-${stamp}`, passwordHash: '', ownerUserId: userId}});
		agentId = agent.id;
		const reader = await db.agent.create({data: {orgId, providerId: 'claude', name: 'Reader', username: `files-cli-test-reader-${stamp}`, passwordHash: '', ownerUserId: userId}});
		readerId = reader.id;
		await db.agentGrant.create({data: {agentId: readerId, connectionId, actionId: 'editFiles', allowed: false}});
		const stranger = await db.agent.create({data: {orgId, providerId: 'claude', name: 'Stranger', username: `files-cli-test-stranger-${stamp}`, passwordHash: '', ownerUserId: userId}});
		strangerId = stranger.id;
		await db.agentGrant.create({data: {agentId: strangerId, connectionId, actionId: 'readFiles', allowed: false}});
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'Chart the quarter', goal: 'A chart', via: 'mcp'}})).id;

		const {handleCliCheckPushRoute, handleCliListFilesRoute, handleCliPullFileRoute, handleCliPushFileRoute} = await import('./cli');
		// The routes as the router mounts them, behind a guard that takes the test's word for who calls.
		const guarded = (handler: (request: CliRequest, response: express.Response) => Promise<void>) => (request: express.Request, response: express.Response) => {
			const as = request.get('x-test-agent') ?? '';
			const agent = {agentId: as, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
			void handler(Object.assign(request, {cli: {agent, taskId, sandboxId: 'sandbox-1'}}), response);
		};
		const app = express();
		app.get('/files/:connectionId/list', guarded(handleCliListFilesRoute));
		app.get('/files/:connectionId/content', guarded(handleCliPullFileRoute));
		app.post('/files/:connectionId/push', guarded(handleCliPushFileRoute));
		app.post('/files/:connectionId/push/check', guarded(handleCliCheckPushRoute));
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

	test('pushes a blob to a path, making the folders on the way, and pulls its bytes back by path', async () => {
		const content = 'date,amount\n2026-07-01,12\n';
		const pushed = await push('Reports/2026/q3.csv', content);
		const made = await pushed.json();

		expect(pushed.status).toBe(200);
		expect(made).toMatchObject({created: true, file: {name: 'q3.csv', path: 'Reports/2026/q3.csv', folder: false, size: 26, type: 'text/csv'}});
		expect(made.link).toStartWith(`https://app.example.com/acme/connections/${connectionId}?folder=`);

		const pulled = await pull({path: '/Reports/2026/q3.csv'});
		expect(pulled.status).toBe(200);
		expect(saidOf(pulled)).toEqual({...made.file, format: null});
		expect(await pulled.text()).toBe('date,amount\n2026-07-01,12\n');
		// By its id, with the path it is at.
		expect(saidOf(await pull({id: made.file.id}))).toEqual({...made.file, format: null});

		// The changes are the agent's, for its task, in the drive's journal: the folders and the file.
		const {db} = await import('@proxy/db');
		const changes = await db.fileChange.findMany({where: {connectionId}, orderBy: {createdAt: 'asc'}});
		expect(changes.map((change) => [change.kind, change.name, change.agentId, change.taskId, change.userId])).toEqual([
			['create', 'Reports', agentId, taskId, null],
			['create', '2026', agentId, taskId, null],
			['create', 'q3.csv', agentId, taskId, null],
		]);
	});

	test('lists a folder by its path and the top without one', async () => {
		const top = await (await pap(`/files/${connectionId}/list`)).json();
		expect(top).toMatchObject({path: '', files: [{name: 'Reports', path: 'Reports', folder: true, version: null}]});

		const inside = await (await pap(`/files/${connectionId}/list?path=Reports/2026`)).json();
		expect(inside.files.map((file: {path: string; size: number}) => [file.path, file.size])).toEqual([['Reports/2026/q3.csv', 26]]);

		const missing = await pap(`/files/${connectionId}/list?path=Reports/2025`);
		expect(missing.status).toBe(422);
		expect(await missing.json()).toEqual({error: 'not_found', message: 'There is no Reports/2025 in this drive.'});
		const file = await pap(`/files/${connectionId}/list?path=Reports/2026/q3.csv`);
		expect((await file.json()).message).toBe('Reports/2026/q3.csv is a file: pap files pull reads it.');
	});

	test('writes over a file only for whoever names the version it holds, or says to write over it, and keeps the versions before', async () => {
		const first = saidOf(await pull({path: 'Reports/2026/q3.csv'})).version;

		const blind = await push('Reports/2026/q3.csv', 'blind');
		expect(blind.status).toBe(422);
		expect(await blind.json()).toEqual({
			error: 'conflict',
			message: `Reports/2026/q3.csv is there already: it holds version ${first} now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.`,
		});

		const written = await (await push('Reports/2026/q3.csv', 'second', {version: first})).json();
		expect(written).toMatchObject({created: false, file: {path: 'Reports/2026/q3.csv', size: 6}});
		const second = written.file.version;
		expect(second).not.toBe(first);

		const stale = await push('Reports/2026/q3.csv', 'lost update', {version: first});
		expect(stale.status).toBe(422);
		expect((await stale.json()).message).toStartWith(`Reports/2026/q3.csv changed since it was pulled: it holds version ${second} now.`);

		const forced = await (await push('Reports/2026/q3.csv', 'third', {force: '1'})).json();
		expect(forced.file.version).not.toBe(second);
		expect(await (await pull({path: 'Reports/2026/q3.csv'})).text()).toBe('third');
		// An earlier version, by the file's id, as a file attached in a thread is named.
		expect(await (await pull({id: written.file.id, version: first})).text()).toBe('date,amount\n2026-07-01,12\n');
		const none = await pull({id: written.file.id, version: 'no-such-version'});
		expect((await none.json()).message).toBe('q3.csv has no version no-such-version.');
	});

	test('refuses what the path can’t be, and a blob that isn’t the agent’s, keeping nothing of it', async () => {
		expect((await (await push('Reports', 'x')).json()).message).toBe('Reports is a folder: give the file’s path inside it, or end the path with a slash, as Reports/, to keep the file’s own name.');
		expect((await (await push('Reports/2026/q3.csv/inside.txt', 'x')).json()).message).toBe('Reports/2026/q3.csv is a file, so nothing goes inside it.');
		expect((await (await push('Drafts/notes.docx', 'x', {convert: '1'})).json()).message).toBe('Files keeps every file as its bytes, of its own type: push it without --convert.');
		expect((await (await pull({path: 'Reports'})).json()).message).toBe('Reports is a folder: pap files ls lists it.');
		expect((await (await pull({path: 'Reports/none.csv'})).json()).message).toBe('There is no Reports/none.csv in this drive.');

		const unknown = await pap(`/files/${connectionId}/push?blob=no-such-blob&path=Drafts/a.txt`, {method: 'POST'});
		expect(unknown.status).toBe(422);
		expect((await unknown.json()).message).toStartWith('There is no blob no-such-blob of yours.');
		const readers = await blobOf('the reader’s', readerId);
		const others = await pap(`/files/${connectionId}/push?blob=${readers}&path=Drafts/b.txt`, {method: 'POST'});
		expect((await others.json()).message).toStartWith(`There is no blob ${readers} of yours.`);

		const top = await (await pap(`/files/${connectionId}/list`)).json();
		expect(top.files.map((file: {name: string}) => file.name)).toEqual(['Reports']);
	});

	test('refuses a push that doesn’t name its blob', async () => {
		const unsaid = await pap(`/files/${connectionId}/push?path=notes.txt`, {method: 'POST'});
		expect(unsaid.status).toBe(422);
		expect((await unsaid.json()).error).toBe('parse_error');
	});

	test('does only what the agent may do with the drive, and works on a drive alone', async () => {
		const before = (await logged()).length;
		const head = saidOf(await pull({path: 'Reports/2026/q3.csv'}, readerId)).version;

		const refused = await push('Reports/2026/q3.csv', 'not allowed', {version: head}, readerId);
		expect(refused.status).toBe(422);
		expect((await refused.json()).error).toBe('forbidden');
		expect(await (await pull({path: 'Reports/2026/q3.csv'})).text()).toBe('third');
		// A new file is still the reader's to add.
		expect((await push('Reports/notes.txt', 'mine', {}, readerId)).status).toBe(200);

		expect((await logged()).slice(before)).toEqual([
			['files_read', 'allowed', 'cli'],
			['files_upload', 'denied', 'cli'],
			['files_read', 'allowed', 'cli'],
			['files_upload', 'allowed', 'cli'],
		]);

		const vault = await pap(`/files/${vaultId}/list`);
		expect(vault.status).toBe(422);
		expect((await vault.json()).message).toStartWith(`${vaultId} is not a drive`);
	});

	test('tells an agent that may not read the drive nothing of its paths by how a push is refused', async () => {
		const before = (await logged()).length;
		// What a push was answered with, as [error, message].
		const said = async (response: Response) => {
			const body = await response.json();
			return [body.error, body.message];
		};

		const there = await said(await push('Reports/2026/q3.csv', 'x', {}, strangerId));
		const nothing = await said(await push('Reports/none.txt', 'x', {}, strangerId));
		const inFile = await said(await push('Reports/2026/q3.csv/inside.txt', 'x', {}, strangerId));
		expect(there[0]).toBe('forbidden');
		expect(nothing).toEqual(there);
		expect(inFile).toEqual(there);

		expect((await logged()).slice(before)).toEqual([
			['files_upload', 'denied', 'cli'],
			['files_upload', 'denied', 'cli'],
			['files_upload', 'denied', 'cli'],
		]);
	});
	test('says what a push would be refused for before its bytes are sent, making nothing and logging only what is refused', async () => {
		const before = (await logged()).length;
		const {db} = await import('@proxy/db');
		const nodes = await db.fileNode.count({where: {connectionId}});
		const head = saidOf(await pull({path: 'Reports/2026/q3.csv'})).version;

		// A push the drive takes: a new file, its folders still to make, and a write at the version held.
		expect(await check('Drafts/2027/plan.pdf')).toEqual([200, undefined, undefined]);
		expect(await check('Reports/2026/q3.csv', {version: head})).toEqual([200, undefined, undefined]);
		expect(await check('Reports/2026/q3.csv', {force: '1'})).toEqual([200, undefined, undefined]);

		// One it refuses, in the words the push itself is refused with.
		expect(await check('Reports/2026/q3.csv', {version: 'stale'})).toEqual([
			422,
			'conflict',
			`Reports/2026/q3.csv changed since it was pulled: it holds version ${head} now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.`,
		]);
		expect(await check('Reports')).toEqual([422, 'validation_error', 'Reports is a folder: give the file’s path inside it, or end the path with a slash, as Reports/, to keep the file’s own name.']);
		expect(await check('Reports/2026/q3.csv/inside.txt')).toEqual([422, 'validation_error', 'Reports/2026/q3.csv is a file, so nothing goes inside it.']);
		expect(await check('Drafts/notes.docx', {convert: '1'})).toEqual([422, 'validation_error', 'Files keeps every file as its bytes, of its own type: push it without --convert.']);
		expect(await check('Drafts/film.mov', {size: String(5 * 1024 * 1024)})).toEqual([422, 'validation_error', 'A file is at most 1 MB, and this one is 5.0 MB.']);
		expect((await check('Reports/2026/q3.csv', {version: head}, readerId))[1]).toBe('forbidden');
		expect((await check('Reports/none.txt', {}, strangerId))[1]).toBe('forbidden');
		const unsaid = await pap(`/files/${connectionId}/push/check?path=notes.txt`, {method: 'POST'});
		expect((await unsaid.json()).error).toBe('parse_error');

		// Nothing was made, and the log holds the pull and what was refused, never a check that passed.
		expect(await db.fileNode.count({where: {connectionId}})).toBe(nodes);
		expect((await logged()).slice(before)).toEqual([
			['files_read', 'allowed', 'cli'],
			['files_upload', 'failed', 'cli'],
			['files_upload', 'failed', 'cli'],
			['files_upload', 'failed', 'cli'],
			['files_upload', 'failed', 'cli'],
			['files_upload', 'denied', 'cli'],
			['files_upload', 'denied', 'cli'],
		]);
	});
});
