import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {DEFAULT_LOOK, readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	createPersona,
	deletePersona,
	ensureMemberChat,
	getMemberChat,
	getPersona,
	listPersonas,
	openThread,
	saveChatDraft,
	sharePersona,
	takeBackPersona,
	type ThreadRow,
} from './harness';
import {provisionOrganization, removeMembership} from './organization';

// Sharing a persona with the organization and taking it back, against a database, as
// harness.test.ts runs: with `bun run test:db` from the repository's root; skipped without
// DATABASE_URL. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};

describe.skipIf(!databaseUrl)('sharing a persona, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let maker = '';
	let other = '';
	let leaver = '';
	let orgId = '';
	// Organizations made in the tests besides the one they share.
	const alsoMade: string[] = [];
	let agentId = '';

	// The member's chat with the persona, made where they have none.
	function chatOf(personaId: string, userId: string): Promise<ThreadRow> {
		return ensureMemberChat({orgId, agentId, personaId, userId}).then(unwrap);
	}

	// A thread the member opens in their chat with what they say.
	async function say(chat: ThreadRow, text: string) {
		const task = {
			orgId,
			agentId,
			ownerUserId: chat.userId,
			personaId: chat.personaId,
			parentId: null,
			title: text,
			goal: text,
			via: 'harness' as const,
		};
		return unwrap(await openThread(chat.id, text, {title: text, task}, readyForInference));
	}

	// Whether others have talked to the persona, as the list `userId` sees says.
	async function usedByOthers(userId: string, personaId: string) {
		return unwrap(await listPersonas(orgId, userId)).find(({id}) => id === personaId)?.usedByOthers;
	}

	// An organization `owner` owns, made as a new one is, with its built-in agent and General.
	async function provision(owner: string, name: string): Promise<string> {
		const made = unwrap(
			await provisionOrganization({
				owner: {userId: owner},
				name,
				slugSource: `${name}-${stamp}`,
				onboardedAt: new Date(),
				builtInAgent: {name: 'Chat', username: `${name}-${stamp}`, passwordHash: ''},
				connections: [],
			}),
		);
		return made.org.id;
	}

	beforeAll(async () => {
		maker = (await db.user.create({data: {email: `sharing-test-${stamp}@example.test`}})).id;
		other = (await db.user.create({data: {email: `sharing-test-other-${stamp}@example.test`}})).id;
		leaver = (await db.user.create({data: {email: `sharing-test-leaver-${stamp}@example.test`}}))
			.id;
		orgId = await provision(maker, 'sharing-test');
		await db.orgMember.createMany({
			data: [
				{orgId, userId: other},
				{orgId, userId: leaver},
			],
		});
		agentId = (await db.agent.findFirstOrThrow({where: {orgId, providerId: 'proxy'}})).id;
	});

	afterAll(async () => {
		await db.organization.deleteMany({where: {id: {in: [orgId, ...alsoMade]}}});
		await db.user.deleteMany({
			where: {id: {in: [maker, other, leaver].filter((id) => id !== '')}},
		});
		await db.$disconnect();
	});

	test('a persona shared with the organization is seen by every member, the maker’s chat staying theirs, and another member’s starting empty', async () => {
		const finance = unwrap(
			await createPersona(orgId, maker, {name: 'Finance', look, color: 'teal'}),
		);
		const makersChat = await chatOf(finance.id, maker);
		await say(makersChat, 'Sum up the invoices from March.');
		expect(unwrap(await getPersona(orgId, other, finance.id))).toBeNull();

		// Only its owner shares it.
		expect(unwrap(await sharePersona(orgId, other, finance.id))).toBe(false);
		expect(unwrap(await sharePersona(orgId, maker, finance.id))).toBe(true);

		expect(unwrap(await getPersona(orgId, other, finance.id))).toMatchObject({
			ownerUserId: null,
			createdById: maker,
		});
		expect(unwrap(await getMemberChat(finance.id, maker))?.id).toBe(makersChat.id);
		expect(unwrap(await getMemberChat(finance.id, other))).toBeNull();
		const othersChat = await chatOf(finance.id, other);
		expect(othersChat.id).not.toBe(makersChat.id);
		const listed = unwrap(await listPersonas(orgId, other)).find(({id}) => id === finance.id);
		expect(listed).toMatchObject({lastMessage: null, draft: null, usedByOthers: true});
		// The maker sees nobody else has said anything to it yet: a chat opened is not talking.
		expect(await usedByOthers(maker, finance.id)).toBe(false);
	});

	test('a persona made shared is every member’s from the start, and its maker takes it back while others have only opened their chat with it, which goes', async () => {
		const travel = unwrap(
			await createPersona(orgId, maker, {name: 'Travel', look, color: 'blue'}, true),
		);
		expect(travel).toMatchObject({ownerUserId: null, createdById: maker});
		const makersChat = await chatOf(travel.id, maker);
		await say(makersChat, 'Book the train to Lyon.');
		const othersChat = await chatOf(travel.id, other);
		unwrap(await saveChatDraft(othersChat.id, 'Find a hotel near'));

		// Only the maker takes it back.
		expect(unwrap(await takeBackPersona(orgId, other, travel.id))).toBe('missing');
		expect(unwrap(await takeBackPersona(orgId, maker, travel.id))).toBe('taken');

		expect(unwrap(await getPersona(orgId, maker, travel.id))?.ownerUserId).toBe(maker);
		expect(unwrap(await getPersona(orgId, other, travel.id))).toBeNull();
		expect(unwrap(await getMemberChat(travel.id, maker))?.id).toBe(makersChat.id);
		expect(await db.agentThread.count({where: {parentThreadId: makersChat.id}})).toBe(1);
		expect(await db.agentThread.count({where: {id: othersChat.id}})).toBe(0);
		// Its own already: nothing to take back.
		expect(unwrap(await takeBackPersona(orgId, maker, travel.id))).toBe('missing');
	});

	test('a shared persona another member has said something to stays shared', async () => {
		const billing = unwrap(
			await createPersona(orgId, maker, {name: 'Billing', look, color: 'pink'}, true),
		);
		await say(await chatOf(billing.id, other), 'Which invoices are still open?');

		expect(await usedByOthers(maker, billing.id)).toBe(true);
		expect(unwrap(await takeBackPersona(orgId, maker, billing.id))).toBe('used');
		expect(unwrap(await getPersona(orgId, other, billing.id))?.ownerUserId).toBeNull();
	});

	test('General, which the organization started with, is its owner’s making: they take it back while nobody else has talked to it, and not once someone has', async () => {
		const [general] = unwrap(await listPersonas(orgId, other)).filter(
			({name}) => name === 'General',
		);
		expect(general).toMatchObject({
			ownerUserId: null,
			createdById: maker,
			look: DEFAULT_LOOK,
			color: 'blue',
		});
		const id = general?.id ?? '';
		await chatOf(id, other);

		expect(unwrap(await takeBackPersona(orgId, other, id))).toBe('missing');
		expect(unwrap(await takeBackPersona(orgId, maker, id))).toBe('taken');
		expect(unwrap(await getPersona(orgId, other, id))).toBeNull();

		expect(unwrap(await sharePersona(orgId, maker, id))).toBe(true);
		await say(await chatOf(id, other), 'What is on this week?');
		expect(unwrap(await takeBackPersona(orgId, maker, id))).toBe('used');
		expect(unwrap(await getPersona(orgId, other, id))?.ownerUserId).toBeNull();
	});

	test('a shared persona whose maker left the organization stays everyone’s, and nobody can take it back', async () => {
		const scout = unwrap(
			await createPersona(orgId, leaver, {name: 'Scout', look, color: 'green'}, true),
		);
		unwrap(await removeMembership({orgId, userId: leaver, sharedAgentPasswordHash: '-'}));

		expect(unwrap(await getPersona(orgId, other, scout.id))).toMatchObject({
			ownerUserId: null,
			createdById: leaver,
		});
		expect(unwrap(await takeBackPersona(orgId, maker, scout.id))).toBe('missing');
		expect(unwrap(await takeBackPersona(orgId, other, scout.id))).toBe('missing');
	});

	test('an organization whose agents were all deleted has none, and listing them makes none', async () => {
		const emptied = await provision(other, 'emptied-test');
		alsoMade.push(emptied);
		const [general, ...more] = unwrap(await listPersonas(emptied, other));
		expect(more).toEqual([]);
		expect(general).toMatchObject({name: 'General', ownerUserId: null, createdById: other});

		expect(unwrap(await deletePersona(emptied, general?.id ?? ''))).toBe(true);
		expect(unwrap(await listPersonas(emptied, other))).toEqual([]);
		expect(unwrap(await listPersonas(emptied, other))).toEqual([]);
	});
});
