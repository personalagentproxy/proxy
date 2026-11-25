import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	createPersona,
	ensureMemberChat,
	getShownThread,
	listChatThreads,
	listPendingMessages,
	saveChatDraft,
	type ThreadOpening,
	type ThreadRow,
} from './harness';
import {linkSlackWorkspace, startSlackApp} from './slack';
import {
	getSlackAppForLink,
	getSlackMember,
	linkSlackMember,
	listSlackMemberLinks,
	noteSlackMessage,
	type SlackMessageTaking,
	takeUpSlackMessage,
	unlinkSlackMember,
} from './slack-messages';

// Slack users' links to members and the messages taken from Slack, against the local database:
// run with it up (`bun run --cwd packages/db db:dev`) and the environment loaded, `bun
// --env-file=../../.env test src/slack-messages.test.ts` from this package. Without DATABASE_URL, as `bun run test` runs, it
// is skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};

describe.skipIf(!databaseUrl)('messages from Slack, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let owner = '';
	let other = '';
	let orgId = '';
	let agentId = '';
	let workspaceId = '';
	let appId = '';
	let personaId = '';

	function chatOf(userId: string): Promise<ThreadRow> {
		return ensureMemberChat({orgId, agentId, personaId, userId}).then(unwrap);
	}

	function opening(chat: ThreadRow, text: string): ThreadOpening {
		return {
			title: text,
			task: {
				orgId,
				agentId,
				ownerUserId: chat.userId,
				personaId,
				parentId: null,
				title: text,
				goal: text,
				via: 'harness',
			},
		};
	}

	function taking(
		chat: ThreadRow,
		ts: string,
		text: string,
		rootTs: string | null = null,
	): SlackMessageTaking {
		return {appId, channel: 'D01', ts, rootTs, chatId: chat.id, text, opening: opening(chat, text)};
	}

	beforeAll(async () => {
		owner = (
			await db.user.create({data: {email: `slack-messages-${stamp}@example.test`, name: 'Dana'}})
		).id;
		other = (await db.user.create({data: {email: `slack-messages-other-${stamp}@example.test`}}))
			.id;
		orgId = (
			await db.organization.create({
				data: {name: 'Slack messages test', slug: `slack-messages-${stamp}`, ownerUserId: owner},
			})
		).id;
		await db.orgMember.createMany({
			data: [
				{orgId, userId: owner},
				{orgId, userId: other},
			],
		});
		agentId = (
			await db.agent.create({
				data: {
					orgId,
					providerId: 'built-in',
					name: 'Built in',
					username: `slack-messages-${stamp}`,
					passwordHash: '',
				},
			})
		).id;
		personaId = unwrap(
			await createPersona(orgId, owner, {name: 'Travel', look, color: 'teal'}, true),
		).id;
		const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
		workspaceId = unwrap(
			await linkSlackWorkspace({
				orgId,
				teamId: `T-${stamp}`,
				name: 'Northwind',
				slackUserId: 'U00',
				linkedById: owner,
				credential: 'sealed',
				expiresAt,
				rotateAt: expiresAt,
			}),
		).id;
		const started = unwrap(
			await startSlackApp({
				orgId,
				personaId,
				workspaceId,
				manifestVersion: 1,
				manifestName: 'Travel',
				addedById: owner,
			}),
		);
		if (started.kind !== 'started') {
			throw new Error(started.kind);
		}
		appId = started.app.id;
	});

	afterAll(async () => {
		await db.slackMessage.deleteMany({where: {appId}});
		await db.slackThreadPlace.deleteMany({where: {appId}});
		await db.slackMemberLink.deleteMany({where: {orgId}});
		await db.slackApp.deleteMany({where: {orgId}});
		await db.slackWorkspace.deleteMany({where: {orgId}});
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: {in: [owner, other]}}});
		await db.$disconnect();
	});

	test('links a Slack user to one member in the workspace, lists it on their account, and unlinks it', async () => {
		expect(unwrap(await getSlackMember(workspaceId, 'U01'))).toBeNull();

		expect(
			unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U01', userId: owner})),
		).toBe('linked');
		expect(
			unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U01', userId: owner})),
		).toBe('already');
		expect(
			unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U01', userId: other})),
		).toBe('other');
		expect(unwrap(await getSlackMember(workspaceId, 'U01'))).toEqual({
			userId: owner,
			inOrganization: true,
		});

		const [link] = unwrap(await listSlackMemberLinks(owner));
		expect(link).toMatchObject({workspaceName: 'Northwind', orgName: 'Slack messages test'});
		expect(unwrap(await listSlackMemberLinks(other))).toEqual([]);

		// Only its member unlinks it.
		expect(unwrap(await unlinkSlackMember(other, link?.id ?? ''))).toBe(false);
		expect(unwrap(await unlinkSlackMember(owner, link?.id ?? ''))).toBe(true);
		expect(unwrap(await getSlackMember(workspaceId, 'U01'))).toBeNull();
	});

	test('two members confirming one Slack user at once link it to one of them', async () => {
		const both = await Promise.all([
			linkSlackMember({orgId, workspaceId, slackUserId: 'U02', userId: owner}),
			linkSlackMember({orgId, workspaceId, slackUserId: 'U02', userId: other}),
		]);

		expect(both.map(unwrap).toSorted()).toEqual(['linked', 'other']);
	});

	test('says a member who left is no longer in the organization, the link kept', async () => {
		unwrap(await linkSlackMember({orgId, workspaceId, slackUserId: 'U03', userId: other}));
		await db.orgMember.deleteMany({where: {orgId, userId: other}});

		expect(unwrap(await getSlackMember(workspaceId, 'U03'))).toEqual({
			userId: other,
			inOrganization: false,
		});
		await db.orgMember.create({data: {orgId, userId: other}});
	});

	test('a message opens a thread in the member’s chat, its draft left, and the Slack thread becomes its place, where alone it lives; a reply there continues it', async () => {
		const chat = await chatOf(owner);
		unwrap(await saveChatDraft(chat.id, 'Half a thought'));

		const opened = unwrap(
			await takeUpSlackMessage(taking(chat, '100.1', 'Book the train to Lyon'), readyForInference),
		);
		expect(opened.kind).toBe('opened');
		const reply = unwrap(
			await takeUpSlackMessage(
				taking(chat, '100.2', 'The 9 o’clock one', '100.1'),
				readyForInference,
			),
		);
		expect(reply).toMatchObject({
			kind: 'continued',
			threadId: opened.kind === 'opened' ? opened.threadId : '',
		});

		// The app doesn't list it: it lives in Slack.
		expect(unwrap(await listChatThreads(chat.id, [], new Date()))).toEqual([]);
		const shown = unwrap(
			await getShownThread(opened.kind === 'opened' ? opened.threadId : '', [], new Date()),
		);
		const threads = shown === null ? [] : [shown];
		expect(threads).toHaveLength(1);
		expect(threads[0]?.parentThreadId).toBe(chat.id);
		expect(threads[0]?.title).toBe('Book the train to Lyon');
		expect(threads[0]?.entries.map(({kind, text}) => ({kind, text}))).toEqual([
			{kind: 'person', text: 'Book the train to Lyon'},
			{kind: 'person', text: 'The 9 o’clock one'},
		]);
		expect((await db.agentThread.findUnique({where: {id: chat.id}}))?.draft).toBe('Half a thought');

		const place = await db.slackThreadPlace.findUnique({
			where: {appId_channel_rootTs: {appId, channel: 'D01', rootTs: '100.1'}},
		});
		expect(place?.threadId).toBe(threads[0]?.id);
		const kept = await db.slackMessage.findMany({
			where: {appId, ts: {in: ['100.1', '100.2']}},
			orderBy: {ts: 'asc'},
		});
		expect(kept.map(({entryId}) => entryId)).toEqual(threads[0]?.entries.map(({id}) => id) ?? []);
	});

	test('a reply in Slack while the thread’s turn runs waits for it, and is given to the model at its next step, as any reply is', async () => {
		const chat = await chatOf(owner);
		const opened = unwrap(
			await takeUpSlackMessage(
				taking(chat, '150.1', 'Compare the fares to Porto'),
				readyForInference,
			),
		);
		const threadId = opened.kind === 'opened' ? opened.threadId : '';
		// The turn its opening queued, now running.
		await db.agentJob.updateMany({
			where: {threadId, kind: 'inference', status: 'queued'},
			data: {status: 'running', claimedBy: 'worker-steer'},
		});

		const reply = unwrap(
			await takeUpSlackMessage(
				taking(chat, '150.2', 'Only direct flights', '150.1'),
				readyForInference,
			),
		);

		expect(reply.kind).toBe('continued');
		const pending = unwrap(await listPendingMessages(threadId));
		expect(pending.map(({kind, text}) => ({kind, text}))).toEqual([
			{kind: 'person', text: 'Only direct flights'},
		]);
		expect(pending[0]?.id).toBe(reply.kind === 'continued' ? reply.entryId : '');
		await db.agentJob.updateMany({where: {threadId}, data: {status: 'done', claimedBy: null}});
	});

	test('a reply under a message never taken up opens a thread tied to that Slack thread', async () => {
		const chat = await chatOf(owner);
		expect(unwrap(await noteSlackMessage({appId, channel: 'D01', ts: '200.1'}))).toBe(true);

		const opened = unwrap(
			await takeUpSlackMessage(taking(chat, '200.2', 'Also the hotel', '200.1'), readyForInference),
		);

		expect(opened.kind).toBe('opened');
		const place = await db.slackThreadPlace.findUnique({
			where: {appId_channel_rootTs: {appId, channel: 'D01', rootTs: '200.1'}},
		});
		expect(place?.threadId).toBe(opened.kind === 'opened' ? opened.threadId : '');
	});

	test('takes a message up once, however often it comes, at once or later; a line is noted once', async () => {
		const chat = await chatOf(owner);
		const both = await Promise.all([
			takeUpSlackMessage(taking(chat, '300.1', 'Find a table for four'), readyForInference),
			takeUpSlackMessage(taking(chat, '300.1', 'Find a table for four'), readyForInference),
		]);

		expect(both.map((one) => unwrap(one).kind).toSorted()).toEqual(['opened', 'taken_already']);
		expect(
			unwrap(
				await takeUpSlackMessage(taking(chat, '300.1', 'Find a table for four'), readyForInference),
			).kind,
		).toBe('taken_already');
		expect(await db.slackThreadPlace.count({where: {appId, rootTs: '300.1'}})).toBe(1);

		expect(unwrap(await noteSlackMessage({appId, channel: 'D01', ts: '300.9'}))).toBe(true);
		expect(unwrap(await noteSlackMessage({appId, channel: 'D01', ts: '300.9'}))).toBe(false);
	});

	test('a message noted with a line is taken up once its writer confirms', async () => {
		const chat = await chatOf(owner);
		unwrap(await noteSlackMessage({appId, channel: 'D01', ts: '400.1'}));

		expect(
			unwrap(await takeUpSlackMessage(taking(chat, '400.1', 'Plan the offsite'), readyForInference))
				.kind,
		).toBe('opened');
		expect(
			(
				await db.slackMessage.findUnique({
					where: {appId_channel_ts: {appId, channel: 'D01', ts: '400.1'}},
				})
			)?.takenUpAt,
		).not.toBeNull();
	});

	test('a reply in a Slack thread of another member’s chat is taken up nowhere', async () => {
		const owners = await chatOf(owner);
		const others = await chatOf(other);
		unwrap(await takeUpSlackMessage(taking(owners, '500.1', 'Book the flight'), readyForInference));

		expect(
			unwrap(
				await takeUpSlackMessage(
					taking(others, '500.2', 'And the car', '500.1'),
					readyForInference,
				),
			).kind,
		).toBe('elsewhere');
		expect(await db.slackMessage.count({where: {appId, ts: '500.2'}})).toBe(0);
	});

	test('reads the app with its persona, workspace and organization, with its owner’s name', async () => {
		expect(unwrap(await getSlackAppForLink(appId))).toMatchObject({
			persona: {name: 'Travel'},
			workspace: {teamId: `T-${stamp}`, name: 'Northwind'},
			org: {name: 'Slack messages test', owner: {name: 'Dana'}},
		});
		expect(unwrap(await getSlackAppForLink('nope'))).toBeNull();
	});
});
