import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';

// What an answer of the agent's shows the person, kept with it (chat.ts `pinned`), against the
// local database and a blob store in a temporary directory. Run with the database up (`bun run
// dev`) and the environment loaded, `bun --env-file=../../.env test --isolate
// src/native/files/chat.test.ts` from this package. Without DATABASE_URL, as `bun run test` runs,
// there is nothing to run against, and this is skipped. Everything made here is one
// organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const blobs = mkdtempSync(join(tmpdir(), 'proxy-files-chat-test-'));
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

describe.skipIf(!databaseUrl)('the files an answer shows', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	const slug = `files-chat-test-${stamp}`;
	let userId = '';
	let otherUserId = '';
	let orgId = '';
	let driveId = '';
	let othersDriveId = '';
	let agent: SignedInAgent;
	let blind: SignedInAgent;

	// A file made in a drive, as a member makes it, with its link as an agent is handed it.
	async function made(connectionId: string, by: string, name: string, bytes: string, type: string) {
		const {createFile} = await import('@proxy/db/files');
		const {storeContent} = await import('./content');
		const change = {orgId, connectionId, by: {userId: by}};
		const stored = unwrap(await storeContent(orgId, new Blob([bytes]).stream(), 1024 * 1024));
		const file = unwrap(await createFile(change, {parentId: null, name, rename: true, content: {blobId: stored.blobId, size: stored.size, type}}));
		return {file, link: `${APP_URL}/${slug}/connections/${connectionId}?file=${file.id}`};
	}

	beforeAll(async () => {
		const {db} = await import('@proxy/db');
		const {createMissingFilesConnection} = await import('@proxy/db/files');
		userId = (await db.user.create({data: {email: `files-chat-test-${stamp}@example.test`}})).id;
		otherUserId = (await db.user.create({data: {email: `files-chat-test-other-${stamp}@example.test`}})).id;
		orgId = (await db.organization.create({data: {name: 'Files chat test', slug, ownerUserId: userId}})).id;
		await db.orgMember.create({data: {orgId, userId}});
		await db.orgMember.create({data: {orgId, userId: otherUserId}});
		unwrap(await createMissingFilesConnection({orgId, userId, integrationId: 'files', defaults: ['readFiles', 'createFiles', 'editFiles']}));
		unwrap(await createMissingFilesConnection({orgId, userId: otherUserId, integrationId: 'files', defaults: ['readFiles', 'createFiles', 'editFiles']}));
		driveId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files', ownerUserId: userId}})).id;
		othersDriveId = (await db.connection.findFirstOrThrow({where: {orgId, integrationId: 'files', ownerUserId: otherUserId}})).id;
		const signedIn = (id: string, name: string): SignedInAgent => ({agentId: id, orgId, ownerUserId: userId, providerId: 'claude', name, orgSlug: slug, experiments: []});
		const chat = await db.agent.create({data: {orgId, providerId: 'proxy', name: 'Chat', username: `files-chat-test-${stamp}`, passwordHash: ''}});
		agent = signedIn(chat.id, 'Chat');
		// An agent the person told it may not read their drive.
		const other = await db.agent.create({data: {orgId, providerId: 'proxy', name: 'Blind', username: `files-chat-test-blind-${stamp}`, passwordHash: ''}});
		await db.agentGrant.create({data: {agentId: other.id, connectionId: driveId, actionId: 'readFiles', allowed: false}});
		blind = signedIn(other.id, 'Blind');
	});

	afterAll(async () => {
		const {db} = await import('@proxy/db');
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		await db.user.deleteMany({where: {id: {in: [userId, otherUserId].filter((id) => id !== '')}}});
	});

	test('keeps each file a picture links to, once, at the version it holds now, and leaves anything else a link', async () => {
		const {chatFiles} = await import('./chat');
		const chart = await made(driveId, userId, 'chart.png', 'not really a png', 'image/png');
		const sheet = await made(driveId, userId, 'q3.csv', 'a,b\n1,2\n', 'text/csv');
		const text = [
			`The chart: ![Revenue by month](${chart.link})`,
			`Again: ![](${chart.link}) and the sheet ![Q3](<${sheet.link}>).`,
			// A link, not a picture; a picture elsewhere; a file of another organization's; one that isn't there.
			`[The chart](${APP_URL}/${slug}/connections/${driveId}?file=${chart.file.id})`,
			'![Cat](https://cdn.example.com/cat.png)',
			`![Theirs](${APP_URL}/elsewhere/connections/${driveId}?file=${chart.file.id})`,
			`![Gone](${APP_URL}/${slug}/connections/${driveId}?file=no-such-file)`,
		].join('\n');

		const pinned = unwrap(await chatFiles.pinned(agent, text));

		expect(pinned).toEqual([
			{connectionId: driveId, fileId: chart.file.id, version: chart.file.head?.id ?? '', name: 'chart.png', type: 'image/png', size: 16, text: null, cut: false},
			{connectionId: driveId, fileId: sheet.file.id, version: sheet.file.head?.id ?? '', name: 'q3.csv', type: 'text/csv', size: 8, text: null, cut: false},
		]);
		expect(unwrap(await chatFiles.pinned(agent, 'No pictures.'))).toEqual([]);
	});

	test('shows only what the agent, as the member it acts for, may read', async () => {
		const {chatFiles} = await import('./chat');
		const mine = await made(driveId, userId, 'mine.png', 'png', 'image/png');
		const theirs = await made(othersDriveId, otherUserId, 'theirs.png', 'png', 'image/png');
		const text = `![Mine](${mine.link}) ![Theirs](${theirs.link})`;

		expect(unwrap(await chatFiles.pinned(agent, text)).map((file) => file.name)).toEqual(['mine.png']);
		expect(unwrap(await chatFiles.pinned(blind, text))).toEqual([]);
	});

	test('shows no folder, and nothing in the trash', async () => {
		const {chatFiles} = await import('./chat');
		const {ensureFolder, trashFile} = await import('@proxy/db/files');
		const change = {orgId, connectionId: driveId, by: {userId}};
		const folder = unwrap(await ensureFolder(change, {parentId: null, name: 'Charts'}));
		const trashed = await made(driveId, userId, 'old.png', 'png', 'image/png');
		unwrap(await trashFile(change, trashed.file.id));
		const text = `![Folder](${APP_URL}/${slug}/connections/${driveId}?file=${folder.id}) ![Old](${trashed.link})`;

		expect(unwrap(await chatFiles.pinned(agent, text))).toEqual([]);
	});
});
