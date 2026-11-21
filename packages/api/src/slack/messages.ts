import {type Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import type {SlackAppRow} from '@proxy/db/slack';
import {getSlackMember, noteSlackMessage, takeUpSlackMessage} from '@proxy/db/slack-messages';

import {ensureChat} from '../harness/member-chat';
import {harnessStore} from '../harness/store';
import {threadOpening} from '../harness/thread-rules';
import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {CONFIRM_LINK_MS, confirmUrl, signConfirmToken} from './confirm-link';
import {confirmLine, lineAfter, planFor, type SaidInSlack, type SlackSpeaker, threadOf} from './message-rules';
import {readBotToken} from './secrets';
import {postMessage} from './slack-api';

/**
 * A person's message in a persona's app's DM, taken up by what message-rules.ts says of it: who is
 * speaking is read from their link to a member; a member's words open a thread in their chat with
 * the persona, made where they have none, or continue the thread their Slack thread is; anyone
 * else gets a line. Everything here is the database's work, done before Slack is answered; the
 * lines it comes to are said after (`postSlackLines`), never holding the answer up. Nothing throws:
 * a failure is logged, and comes to no line. The thread a message opens lives in Slack alone
 * (db/harness `IN_APP`).
 */

/** A line the app is to say in a Slack thread of its DM. */
export type SlackLine = {channel: string; threadTs: string; text: string};

/** The app as taking a message up needs it: its workspace, with its Slack id, its persona, and its organization, with its name. */
export type SlackAppForMessages = Pick<SlackAppRow, 'id' | 'orgId' | 'personaId' | 'workspaceId'> & {org: {name: string}; workspace: {teamId: string}};

// Who the Slack user is in the organization.
function speakerOf(app: SlackAppForMessages, slackUserId: string): Promise<Result<SlackSpeaker, ApiError>> {
	return Do(async ($) => {
		const member = $(await getSlackMember(app.workspaceId, slackUserId));
		if (member === null) {
			return {kind: 'unknown'};
		}
		return member.inOrganization ? {kind: 'member', userId: member.userId} : {kind: 'gone'};
	});
}

// The link a Slack user linked to nobody confirms who they are with, for this message; null where
// the server has no AUTH_SECRET or APP_URL to make one with.
function linkFor(app: SlackAppForMessages, said: SaidInSlack): string | null {
	const {AUTH_SECRET: secret, APP_URL: appUrl} = env;
	if (!secret || !appUrl) {
		log.error('A Slack user can’t be asked to confirm who they are without AUTH_SECRET and APP_URL', {appId: app.id});
		return null;
	}
	const expiresAt = Math.floor((Date.now() + CONFIRM_LINK_MS) / 1000);
	return confirmUrl(appUrl, signConfirmToken({appId: app.id, teamId: app.workspace.teamId, slackUserId: said.slackUserId, channel: said.channel, ts: said.ts, expiresAt}, secret));
}

/** What a message came to: whether it is in a thread, taken up now or before, and the lines to say in Slack. */
export type SlackMessageOutcome = {takenUp: boolean; lines: SlackLine[]};

// What a message comes to, taken up where its writer is a member.
function takeUp(app: SlackAppForMessages, said: SaidInSlack, known: SlackSpeaker | null): Promise<Result<SlackMessageOutcome, ApiError>> {
	return Do(async ($) => {
		const plan = planFor(said, known ?? $(await speakerOf(app, said.slackUserId)), app.org.name);
		const key = {appId: app.id, channel: said.channel, ts: said.ts};
		const line = (text: string | null): SlackLine[] => (text === null ? [] : [{channel: said.channel, threadTs: threadOf(said), text}]);
		if (plan.kind === 'leave') {
			return {takenUp: false, lines: []};
		}
		if (plan.kind === 'say') {
			return {takenUp: false, lines: $(await noteSlackMessage(key)) ? line(plan.line) : []};
		}
		if (plan.kind === 'confirm') {
			const url = linkFor(app, said);
			if (url === null || !$(await noteSlackMessage(key))) {
				return {takenUp: false, lines: []};
			}
			return {takenUp: false, lines: line(confirmLine(url))};
		}
		const chat = $(await ensureChat(harnessStore, {orgId: app.orgId, userId: plan.userId}, {id: app.personaId}));
		const taken = $(await takeUpSlackMessage({...key, chatId: chat.id, rootTs: said.rootTs, text: plan.text, opening: threadOpening(chat, {text: plan.text, files: []})}, readyForInference));
		// Taken up nowhere, it is answered once, as a line alone is.
		if (taken.kind === 'elsewhere') {
			return {takenUp: false, lines: $(await noteSlackMessage(key)) ? line(lineAfter(plan, taken.kind)) : []};
		}
		const takenUp = taken.kind === 'opened' || taken.kind === 'continued' || taken.kind === 'taken_already';
		return {takenUp, lines: line(lineAfter(plan, taken.kind))};
	});
}

/**
 * What a person said in the app's DM comes to, in the database: taken up, or noted as answered;
 * with the lines to say after. Who is speaking is read from their link, unless the caller knows,
 * as confirming does. Nothing where it fails, which is logged.
 */
export async function takeUpSlackMessageFrom(app: SlackAppForMessages, said: SaidInSlack, known: SlackSpeaker | null = null): Promise<SlackMessageOutcome> {
	const outcome = await takeUp(app, said, known);
	if (outcome.isErr()) {
		log.error('A Slack message could not be taken up', {appId: app.id, ...serializeError(outcome.error)});
		return {takenUp: false, lines: []};
	}
	return outcome.value;
}

/** Says the lines in Slack with the app's bot, one after the other; one that fails is logged and dropped. */
export async function postSlackLines(app: Pick<SlackAppRow, 'id' | 'botToken'>, lines: SlackLine[]): Promise<void> {
	if (lines.length === 0) {
		return;
	}
	const token = app.botToken === null ? null : readBotToken(app.botToken).unwrapOr(null);
	if (token === null) {
		log.warn('A Slack app has no bot token to answer with', {appId: app.id});
		return;
	}
	for (const line of lines) {
		const posted = await postMessage(token, line);
		if (posted.isErr()) {
			log.warn('A line could not be said in Slack', {appId: app.id, method: posted.error.method, kind: posted.error.kind, ...(posted.error.kind === 'refused' ? {error: posted.error.error} : {})});
		}
	}
}
