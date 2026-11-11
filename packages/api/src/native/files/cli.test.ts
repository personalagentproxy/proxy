import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import express from 'express';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import type {CliRequest} from '../../server/middleware/require-cli';

// A drive as code in a sandbox reaches it with `pap files`, end to end: the three routes over
// HTTP, as the token's agent and task, against the local database and a blob store in a temporary
// directory. Run with the database up (`bun run dev`) and the environment loaded,
// `bun --env-file=../../.env test --isolate src/native/files/cli.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-files-cli-test-'));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'https://app.example.com', FILES_DIR: blobs, FILES_MAX_MB: 1}}));
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

	function push(path: string, content: string, query: Record<string, string> = {}, as?: string): Promise<Response> {
		const params = new URLSearchParams({path, ...query});
		return pap(`/files/${connectionId}/content?${params.toString()}`, {method: 'PUT', headers: {'content-type': 'application/octet-stream'}, body: content, as});
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
		const {createMissingFilesConnection} = await import('@proxy/db/files');
		const user = await db.user.create({data: {email: `files-cli-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Files cli test', slug: `files-cli-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		await db.orgMember.create({data: {orgId, userId}});
		unwrap(await createMissingFilesConnection({orgId, userId, integrationId: 'files', defaults: ['readFiles', 'createFiles', 'editFiles']}));
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

		const {handleCliListFilesRoute, handleCliPullFileRoute, handleCliPushFileRoute} = await import('./cli');
		// The routes as the router mounts them, behind a guard that takes the test's word for who calls.
		const guarded = (handler: (request: CliRequest, response: express.Response) => Promise<void>) => (request: express.Request, response: express.Response) => {
			const as = request.get('x-test-agent') ?? '';
			const agent = {agentId: as, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
			void handler(Object.assign(request, {cli: {agent, taskId, sandboxId: 'sandbox-1'}}), response);
		};
		const app = express();
		app.get('/files/:connectionId/list', guarded(handleCliListFilesRoute));
		app.get('/files/:connectionId/content', guarded(handleCliPullFileRoute));
		app.put('/files/:connectionId/content', guarded(handleCliPushFileRoute));
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

	test('pushes a new file to a path, making the folders on the way, and pulls its bytes back by path', async () => {
		const pushed = await push('Reports/2026/q3.csv', 'date,amount\n2026-07-01,12\n');
		const made = await pushed.json();

		expect(pushed.status).toBe(200);
		expect(made).toMatchObject({created: true, file: {name: 'q3.csv', path: 'Reports/2026/q3.csv', folder: false, size: 26, type: 'text/csv'}});
		expect(made.link).toStartWith(`https://app.example.com/acme/connections/${connectionId}?folder=`);

		const pulled = await pull({path: '/Reports/2026/q3.csv'});
		expect(pulled.status).toBe(200);
		expect(saidOf(pulled)).toEqual(made.file);
		expect(await pulled.text()).toBe('date,amount\n2026-07-01,12\n');

		// The change is the agent's, for its task, in the drive's journal.
		const {db} = await import('@proxy/db');
		const change = await db.fileChange.findFirstOrThrow({where: {connectionId, fileId: made.file.id}});
		expect(change).toMatchObject({kind: 'create', agentId, taskId, userId: null});
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
		// An earlier version, by the file's id, as a file attached to a conversation is named.
		expect(await (await pull({id: written.file.id, version: first})).text()).toBe('date,amount\n2026-07-01,12\n');
		const none = await pull({id: written.file.id, version: 'no-such-version'});
		expect((await none.json()).message).toBe('q3.csv has no version no-such-version.');
	});

	test('refuses what the path can’t be, and a file larger than the server takes, keeping nothing of it', async () => {
		expect((await (await push('Reports', 'x')).json()).message).toBe('Reports is a folder: give the file’s path inside it, or end the path with a slash, as Reports/, to keep the file’s own name.');
		expect((await (await push('Reports/2026/q3.csv/inside.txt', 'x')).json()).message).toBe('Reports/2026/q3.csv is a file, so nothing goes inside it.');
		expect((await (await pull({path: 'Reports'})).json()).message).toBe('Reports is a folder: pap files ls lists it.');
		expect((await (await pull({path: 'Reports/none.csv'})).json()).message).toBe('There is no Reports/none.csv in this drive.');

		const huge = await push('huge.bin', 'x'.repeat(1024 * 1024 + 1));
		expect(huge.status).toBe(422);
		expect((await huge.json()).message).toBe('A file is at most 1 MB.');
		const top = await (await pap(`/files/${connectionId}/list`)).json();
		expect(top.files.map((file: {name: string}) => file.name)).toEqual(['Reports']);
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
			['files_write', 'denied', 'cli'],
			['files_read', 'allowed', 'cli'],
			['files_create', 'allowed', 'cli'],
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
			['files_create', 'denied', 'cli'],
			['files_create', 'denied', 'cli'],
			['files_create', 'denied', 'cli'],
		]);
	});
});
