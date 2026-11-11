import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

// A drive as an agent works in it, end to end: the tools and the collection against the local
// database and a blob store in a temporary directory. Run with the database up (`bun run dev`)
// and the environment loaded, `bun --env-file=../../.env test --isolate src/native/files/files.test.ts`
// from this package. Without DATABASE_URL, as `bun run test` runs, there is nothing to run
// against, and this is skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-files-test-'));

mock.module('../../utils/env', () => ({env: {APP_URL: 'https://app.example.com', FILES_DIR: blobs, FILES_MAX_MB: 1}}));

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

describe.skipIf(!databaseUrl)('files, as an agent works in them', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let taskId = '';
	let agentId = '';

	async function tool(name: string, params: Record<string, unknown>): Promise<Result<string, ApiError>> {
		const {FILES_INTEGRATION} = await import('./integration');
		const runner = FILES_INTEGRATION.tools?.[name];
		if (!runner) {
			throw new Error(`no tool ${name}`);
		}
		const agent = {agentId, orgId, ownerUserId: userId, providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};
		return runner({caller: {agent, via: 'mcp', taskId}, connection: {id: connectionId, orgId} as never, params});
	}

	async function target() {
		const {findCollection, findIntegration} = await import('@proxy/integrations');
		const integration = findIntegration('files');
		const collection = integration && findCollection(integration, 'files');
		if (!collection) {
			throw new Error('no files collection');
		}
		return {connection: {id: connectionId, orgId} as never, collection};
	}

	async function list(query: {parent?: string; search?: string} = {}) {
		const {filesConnector} = await import('./connector');
		return filesConnector.list(await target(), {search: query.search ?? null, page: null, filter: null, parent: query.parent ?? null});
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const {createMissingFilesConnection} = await import('@proxy/db/files');
		const user = await db.user.create({data: {email: `files-api-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({data: {name: 'Files api test', slug: `files-api-test-${stamp}`, ownerUserId: userId}});
		orgId = org.id;
		unwrap(await createMissingFilesConnection({orgId, userId, integrationId: 'files', defaults: []}));
		connectionId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files'}})).id;
		const agent = await db.agent.create({data: {orgId, providerId: 'claude', name: 'Claude', username: `files-api-test-${stamp}`, passwordHash: ''}});
		agentId = agent.id;
		taskId = (await db.agentTask.create({data: {orgId, agentId, title: 'Write up the offsite', goal: 'Notes', via: 'mcp'}})).id;
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

	test('adds a file as text and reads it back, with the version a write has to name and the link the person opens', async () => {
		const folder = unwrap(await tool('files_create', {name: 'Offsite', folder: true}));
		const folderId = lineOf(folder, 'Id');
		const made = unwrap(await tool('files_create', {name: 'notes.md', parent: folderId, content: '# Offsite\n\nBook the room.'}));
		const id = lineOf(made, 'Id');

		expect(made).toStartWith('Added notes.md.');
		expect(lineOf(made, 'Link')).toBe(`https://app.example.com/acme/connections/${connectionId}?folder=${folderId}&file=${id}`);
		expect(lineOf(folder, 'Link')).toBe(`https://app.example.com/acme/connections/${connectionId}?folder=${folderId}`);

		const read = unwrap(await tool('files_read', {id}));
		expect(lineOf(read, 'Path')).toBe('Offsite/notes.md');
		expect(lineOf(read, 'Version')).toBe(lineOf(made, 'Version'));
		expect(lineOf(read, 'Type')).toBe('text/markdown');
		expect(read).toEndWith('\n\n# Offsite\n\nBook the room.');

		// The bytes are in the store, under the organization, and nowhere in the database.
		expect(readdirSync(join(blobs, orgId)).length).toBeGreaterThan(0);
		expect(refusal(await tool('files_create', {name: 'notes.md', parent: folderId, content: 'again'}))).toBe('conflict: Something is already called notes.md there.');
		expect(refusal(await tool('files_create', {name: 'a/b.md'}))).toStartWith('validation_error');
		expect(refusal(await tool('files_read', {id: folderId}))).toStartWith('validation_error: Offsite is a folder');
	});

	test('lists a folder and opens a file as records, a folder’s list saying where it is', async () => {
		const top = unwrap(await list());
		const folder = top.records.find((record) => record.values.name === 'Offsite');
		expect(folder).toMatchObject({values: {kind: 'Folder'}, hasChildren: true});

		const inside = unwrap(await list({parent: folder?.id}));
		expect(inside.trail).toEqual([{id: folder?.id ?? '', title: 'Offsite'}]);
		expect(inside.records.map((record) => [record.values.name, record.values.kind])).toEqual([['notes.md', 'File']]);
		expect(unwrap(await list({search: 'NOTES'})).records.map((record) => record.values.name)).toEqual(['notes.md']);

		const {filesConnector} = await import('./connector');
		const opened = unwrap(await filesConnector.get(await target(), inside.records[0]?.id ?? ''));
		expect(opened.values.content).toBe('# Offsite\n\nBook the room.');
		expect(refusal(await list({parent: inside.records[0]?.id}))).toStartWith('validation_error: notes.md is a file');
	});

	test('writes over a file only with the version that was read, keeps the one before, and gives it back', async () => {
		const made = unwrap(await tool('files_create', {name: 'plan.md', content: 'First plan.'}));
		const id = lineOf(made, 'Id');
		const first = lineOf(made, 'Version');

		const written = unwrap(await tool('files_write', {id, version: first, content: 'Second plan.'}));
		const second = lineOf(written, 'Version');
		expect(second).not.toBe(first);
		// Whoever still has the first version in hand is told what the file holds now.
		expect(refusal(await tool('files_write', {id, version: first, content: 'Lost update.'}))).toBe(
			`conflict: plan.md changed since that version was read: it holds ${second} now. Read it again with files_read, then write.`,
		);
		expect(unwrap(await tool('files_read', {id}))).toEndWith('Second plan.');

		const versions = unwrap(await tool('files_versions', {id}));
		expect(versions.split('\n')).toEqual([
			'plan.md has 2 versions, newest first:',
			expect.stringMatching(new RegExp(`^${second} \\(now\\): .*, 12 B by Claude for “Write up the offsite”$`)),
			expect.stringMatching(new RegExp(`^${first}: .*, 11 B by Claude for “Write up the offsite”$`)),
		]);
		const earlier = unwrap(await tool('files_read', {id, version: first}));
		expect(lineOf(earlier, 'Version')).toBe(`${first} (an earlier version: it holds ${second} now)`);
		expect(earlier).toEndWith('First plan.');

		const restored = unwrap(await tool('files_restore', {id, version: first}));
		expect(lineOf(restored, 'Version')).not.toBe(first);
		expect(unwrap(await tool('files_read', {id}))).toEndWith('First plan.');
		expect(unwrap(await tool('files_versions', {id}))).toContain('an earlier version given back');
		expect(refusal(await tool('files_read', {id, version: 'no-such-version'}))).toStartWith('not_found: plan.md has no version no-such-version');
	});

	test('reads a long file a stretch at a time, and says what a file that isn’t text is', async () => {
		const long = `${'a'.repeat(50_000)}${'b'.repeat(20_000)}`;
		const made = unwrap(await tool('files_create', {name: 'long.txt', content: long}));
		const id = lineOf(made, 'Id');

		const first = unwrap(await tool('files_read', {id}));
		expect(lineOf(first, 'Length')).toBe('Characters 0 to 50000 of 70000. Read on with files_read from 50000.');
		expect(first).toEndWith('a');
		const rest = unwrap(await tool('files_read', {id, from: 50_000}));
		expect(lineOf(rest, 'Length')).toBe('Characters 50000 to 70000 of 70000.');
		expect(rest).toEndWith(`\n\n${'b'.repeat(20_000)}`);

		// A picture, uploaded as the web app does it.
		const {storeContent} = await import('./content');
		const {createFile} = await import('@proxy/db/files');
		const stored = unwrap(await storeContent(orgId, new Response(new Uint8Array([137, 80, 78, 71])).body ?? new ReadableStream(), 1024));
		const picture = unwrap(await createFile({orgId, connectionId, by: {userId}}, {parentId: null, name: 'chart.png', content: {blobId: stored.blobId, size: stored.size, type: 'image/png'}}));
		const read = unwrap(await tool('files_read', {id: picture.id}));
		expect(read).toContain('(image/png, 4 B. “chart.png” (image/png) can’t be read as text');
		expect(unwrap(await tool('files_versions', {id: picture.id}))).toContain(`by files-api-test-${stamp}@example.test`);
	});

	test('takes no file larger than the server allows, and keeps nothing of it', async () => {
		expect(refusal(await tool('files_create', {name: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1)}))).toBe('validation_error: A file is at most 1 MB.');
		expect(unwrap(await list({search: 'huge'})).records).toEqual([]);
	});

	test('renames and moves, to the top too, and puts in the trash and takes out again', async () => {
		const folderId = lineOf(unwrap(await tool('files_create', {name: 'Archive', folder: true})), 'Id');
		const id = lineOf(unwrap(await tool('files_create', {name: 'loose.txt', content: 'x'})), 'Id');

		expect(unwrap(await tool('files_move', {id, parent: folderId, name: 'filed.txt'}))).toStartWith('It is Archive/filed.txt now.');
		expect(unwrap(await tool('files_move', {id, parent: 'top'}))).toStartWith('It is filed.txt now.');
		expect(refusal(await tool('files_move', {id}))).toStartWith('validation_error');

		expect(unwrap(await tool('files_trash', {id}))).toBe(`Moved filed.txt to the trash. files_untrash with its id, ${id}, takes it out.`);
		expect(refusal(await tool('files_read', {id}))).toBe('not_found: It is in the trash.');
		expect(unwrap(await tool('files_untrash', {id}))).toStartWith('Took filed.txt out of the trash.');
		expect(unwrap(await tool('files_read', {id}))).toEndWith('x');
	});
});
