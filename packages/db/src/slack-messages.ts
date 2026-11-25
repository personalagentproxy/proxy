import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {
	appendEntry,
	lockChat,
	openThreadIn,
	type ThreadOpening,
	type ThreadRow,
	threadSelect,
	toThread,
	type Wakes,
	wakeWith,
} from './harness';
import {appSelect, type SlackAppRow} from './slack';

/**
 * What comes from Slack into the organization's threads: a Slack user's link to a member
 * (SlackMemberLink), which says who is speaking, made by the member's own confirmation; a
 * thread's place in Slack (SlackThreadPlace); and each message taken from Slack (SlackMessage),
 * kept once by the app, the DM's channel and its `ts`, so a message Slack sends again, or two api
 * instances get at once, is answered or taken up once. A message is taken up with its writer's chat
 * locked, as everything said in a chat is, so two copies of it are taken one after the other, the
 * second finding the first. A thread opened from Slack lives there alone (harness.ts `IN_APP`).
 */

/** Who a Slack user is in the organization: the member they are linked to, and whether that member is still in it. */
export type SlackMember = {userId: string; inOrganization: boolean};

/** The member the Slack user is linked to in the workspace; `Ok(null)` for none. */
export async function getSlackMember(
	workspaceId: string,
	slackUserId: string,
): Promise<Result<SlackMember | null, ApiError>> {
	return wrapDb(async () => {
		const link = await db.slackMemberLink.findUnique({
			where: {workspaceId_slackUserId: {workspaceId, slackUserId}},
			select: {orgId: true, userId: true},
		});
		if (!link) {
			return null;
		}
		const member = await db.orgMember.count({where: {orgId: link.orgId, userId: link.userId}});
		return {userId: link.userId, inOrganization: member > 0};
	});
}

/** What linking a Slack user to a member came to: linked now, linked to them already, or linked to another member. */
export type SlackMemberLinking = 'linked' | 'already' | 'other';

/** Links the Slack user to the member in the workspace, where they are linked to nobody; one member per Slack user, two at once making one. */
export async function linkSlackMember(link: {
	orgId: string;
	workspaceId: string;
	slackUserId: string;
	userId: string;
}): Promise<Result<SlackMemberLinking, ApiError>> {
	const {workspaceId, slackUserId, userId} = link;
	return wrapDb(async (): Promise<SlackMemberLinking> => {
		const made = await db.slackMemberLink.createMany({data: [link], skipDuplicates: true});
		if (made.count > 0) {
			return 'linked';
		}
		const kept = await db.slackMemberLink.findUnique({
			where: {workspaceId_slackUserId: {workspaceId, slackUserId}},
			select: {userId: true},
		});
		return kept?.userId === userId ? 'already' : 'other';
	});
}

/** A member's link to a Slack user, as their account lists it: the workspace's name and the organization's. */
export type SlackMemberLinkRow = {
	id: string;
	workspaceName: string;
	orgName: string;
	createdAt: Date;
};

/** The Slack users the member is linked to, in every organization, oldest first. */
export async function listSlackMemberLinks(
	userId: string,
): Promise<Result<SlackMemberLinkRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.slackMemberLink.findMany({
				where: {userId},
				select: {
					id: true,
					createdAt: true,
					workspace: {select: {name: true}},
					org: {select: {name: true}},
				},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map((rows) =>
		rows.map((row) => ({
			id: row.id,
			workspaceName: row.workspace.name,
			orgName: row.org.name,
			createdAt: row.createdAt,
		})),
	);
}

/** Unlinks one of the member's links; `Ok(false)` for none of theirs. */
export async function unlinkSlackMember(
	userId: string,
	linkId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.slackMemberLink.deleteMany({where: {id: linkId, userId}}))).map(
		({count}) => count > 0,
	);
}

/** A message in a persona's app's DM, by the app, the DM's channel and its `ts`. */
export type SlackMessageKey = {appId: string; channel: string; ts: string};

/**
 * Notes that the app answered the message with a line, and took nothing up: `Ok(true)` the first
 * time, so the line is said once however often Slack sends the message; a message taken up already
 * is noted too.
 */
export async function noteSlackMessage(key: SlackMessageKey): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.slackMessage.createMany({data: [key], skipDuplicates: true}))).map(
		({count}) => count > 0,
	);
}

/** A member's message from Slack, to be taken up in their chat with the app's persona. */
export type SlackMessageTaking = SlackMessageKey & {
	chatId: string;
	// The root message's `ts` of the Slack thread it was said in; null for a message at the top of the DM.
	rootTs: string | null;
	text: string;
	// How the message opens a thread where it opens one.
	opening: ThreadOpening;
};

/**
 * What taking up a message came to: a thread opened with it, or one continued; nothing, as it was
 * taken up already, its Slack thread is a thread of another member's chat, or there is no such chat.
 */
export type SlackTakeUp = SlackTaken | {kind: 'taken_already' | 'elsewhere' | 'no_chat'};

/** A message taken up: the thread it opened or continued, and the entry it became. */
export type SlackTaken = {kind: 'opened' | 'continued'; threadId: string; entryId: string};

/**
 * Takes the message up in the member's chat, in one transaction with the chat locked: where it was
 * taken up already, nothing. A reply in a Slack thread that is a thread's place continues that
 * thread, waking its agent as a reply in the app does, so one said while its turn runs reaches the
 * model at its next step; any other message opens a thread with it, as a message in the app does,
 * its agent woken on it, and the Slack thread it starts, or was said in, becomes the thread's place.
 * The message is kept with the entry it became, in the same transaction.
 */
export async function takeUpSlackMessage(
	taking: SlackMessageTaking,
	wakes: Wakes,
): Promise<Result<SlackTakeUp, ApiError>> {
	const {appId, channel, ts, chatId, rootTs} = taking;
	return wrapDb(() =>
		db.$transaction(async (tx): Promise<SlackTakeUp> => {
			const chat = await lockChat(tx, chatId);
			if (!chat) {
				return {kind: 'no_chat'};
			}
			const seen = await tx.slackMessage.findUnique({
				where: {appId_channel_ts: {appId, channel, ts}},
				select: {takenUpAt: true},
			});
			if (seen?.takenUpAt) {
				return {kind: 'taken_already'};
			}
			const place =
				rootTs === null
					? null
					: await tx.slackThreadPlace.findUnique({
							where: {appId_channel_rootTs: {appId, channel, rootTs}},
							select: {threadId: true},
						});
			const taken = place
				? await continueThread(tx, chat, place.threadId, taking.text, wakes)
				: await openPlacedThread(tx, chat, taking, wakes);
			if (taken.kind === 'elsewhere') {
				return taken;
			}
			const takenUpAt = new Date();
			await tx.slackMessage.upsert({
				where: {appId_channel_ts: {appId, channel, ts}},
				create: {appId, channel, ts, entryId: taken.entryId, takenUpAt},
				update: {entryId: taken.entryId, takenUpAt},
				select: {id: true},
			});
			return taken;
		}),
	);
}

// A reply in the Slack thread that is the thread's place, landed in the thread as a reply in the
// app is; elsewhere where the thread isn't one of the chat's. With the chat locked.
async function continueThread(
	tx: Prisma.TransactionClient,
	chat: ThreadRow,
	threadId: string,
	text: string,
	wakes: Wakes,
): Promise<SlackTaken | {kind: 'elsewhere'}> {
	const thread = await tx.agentThread.findFirst({
		where: {id: threadId, parentThreadId: chat.id},
		select: threadSelect,
	});
	if (!thread) {
		return {kind: 'elsewhere'};
	}
	const entry = await wakeWith(tx, toThread(thread), {kind: 'person', text}, wakes);
	return {kind: 'continued', threadId: thread.id, entryId: entry.id};
}

// A thread opened in the chat with the message, as openThread opens one in the app, but leaving
// what the member typed in the chat as it is, since this isn't it sent; the Slack thread it starts,
// or was said in, its place. With the chat locked.
async function openPlacedThread(
	tx: Prisma.TransactionClient,
	chat: ThreadRow,
	taking: SlackMessageTaking,
	wakes: Wakes,
): Promise<SlackTaken> {
	const {appId, channel, ts, rootTs, text, opening} = taking;
	const thread = await openThreadIn(tx, chat, opening, false);
	// Its place first, so the thread is never one of the app's, even within the transaction.
	await tx.slackThreadPlace.create({
		data: {appId, channel, rootTs: rootTs ?? ts, threadId: thread.id},
		select: {id: true},
	});
	const entry = await appendEntry(tx, thread, {kind: 'person', text}, wakes);
	return {kind: 'opened', threadId: thread.id, entryId: entry.id};
}

/** A persona's app with what the page confirming a Slack user needs: its persona's name, its workspace, and its organization, with whom to ask to be invited. */
export type SlackAppForLink = SlackAppRow & {
	persona: {name: string};
	workspace: {teamId: string; name: string};
	org: {
		name: string;
		slug: string;
		experiments: string[];
		insider: boolean;
		owner: {name: string | null};
	};
};

/** The app by our id for it, with its workspace and organization; `Ok(null)` for none. */
export async function getSlackAppForLink(
	id: string,
): Promise<Result<SlackAppForLink | null, ApiError>> {
	return wrapDb(() =>
		db.slackApp.findUnique({
			where: {id},
			select: {
				...appSelect,
				persona: {select: {name: true}},
				workspace: {select: {teamId: true, name: true}},
				org: {
					select: {
						name: true,
						slug: true,
						experiments: true,
						insider: true,
						owner: {select: {name: true}},
					},
				},
			},
		}),
	);
}
