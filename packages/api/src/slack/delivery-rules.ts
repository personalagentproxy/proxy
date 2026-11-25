import {hasExperiment, organizationExperiments} from '@proxy/utils';
import type {SlackDelivery, SlackDeliveryMark, SlackUndelivered} from '@proxy/db/slack-delivery';

import {shownParts, type ShownPart, type SubAgentRef} from '../harness/thread-shown';
import type {SlackError} from './slack-api';
import {isTokenGone} from './slack-errors';
import {splitForSlack, toSlackMarkdown} from './slack-markdown';

/**
 * What a thread that lives in Slack comes to there, with no Slack and no database in it: the
 * messages its entries are, in order, each as Markdown for `markdown_text`, from what the member
 * reads of the thread (harness/thread-shown.ts). What the agent answered, what it told the member as
 * it went, and a failure go as they are written; an alert that fired, as the one line the Chat page
 * reads it as, under a short lead. Not what the member said, which they wrote in Slack and is there
 * already (the app never shows a Slack thread, so nothing is said in one from it), nor the lines for
 * the sub-agents the agent started or wrote to, which Slack shows as the thread at work instead
 * (session-rules.ts), nor anything pending. An entry may be several messages, numbered in order
 * (`part`), and its last says the entry is done, so the mark can move message by message
 * (`markAfter`). delivery.ts posts them.
 */

/** One Slack message an entry comes to: the entry's `seq`, its place among the entry's messages, whether it is the last, and its Markdown. */
export type SlackOutgoing = {seq: number; part: number; last: boolean; markdown: string};

/** The lead before an alert that fired in the thread. */
export const ALERT_LEAD = 'Alert:';

// What one thing the thread shows says in Slack; null for nothing, as for marks of files alone and
// a sub-agent's line.
function markdownOf<S extends SubAgentRef>(part: ShownPart<S>, appUrl: string): string | null {
	if (part.kind === 'sub_agent') {
		return null;
	}
	if (part.kind === 'event') {
		const line = toSlackMarkdown(part.line, appUrl);
		return line === '' ? null : `${ALERT_LEAD} ${line}`;
	}
	const words = toSlackMarkdown(part.text, appUrl);
	return words === '' ? null : words;
}

/** The Slack messages the thread's entries come to, in order, each entry's numbered from 0. */
export function outgoingOf(read: SlackUndelivered, appUrl: string): SlackOutgoing[] {
	const thread = {subAgentOfId: null, subAgents: read.subAgents};
	return read.entries.flatMap((entry) => {
		if (entry.pending || entry.kind === 'person') {
			return [];
		}
		const texts = shownParts(thread, entry).flatMap((part) => {
			const markdown = markdownOf(part, appUrl);
			return markdown === null ? [] : splitForSlack(markdown);
		});
		return texts.map((markdown, part) => ({seq: entry.seq, part, last: part === texts.length - 1, markdown}));
	});
}

/** Of the messages, those past the mark: not of an entry delivered, nor those of the entry it is part way through that were posted. */
export function pastMark(messages: SlackOutgoing[], mark: SlackDeliveryMark): SlackOutgoing[] {
	return messages.filter((message) => message.seq > mark.deliveredSeq && !(message.seq === mark.partSeq && message.part < mark.partsPosted));
}

/** The mark once the message is posted, or skipped: past its entry where it is the entry's last; otherwise part way through it. */
export function markAfter(message: SlackOutgoing, mark: SlackDeliveryMark): SlackDeliveryMark {
	if (message.last) {
		return {deliveredSeq: message.seq, partSeq: null, partsPosted: 0};
	}
	return {deliveredSeq: mark.deliveredSeq, partSeq: message.seq, partsPosted: message.part + 1};
}

/** The mark past every entry read, once each message of theirs is delivered: what isn't shown, and what the member said in Slack, are passed over with them. */
export function markPast(entries: SlackUndelivered['entries'], mark: SlackDeliveryMark): SlackDeliveryMark {
	const last = entries.at(-1);
	if (last === undefined || last.seq <= mark.deliveredSeq) {
		return mark;
	}
	return {deliveredSeq: last.seq, partSeq: null, partsPosted: 0};
}

/**
 * Whether anything is delivered to the place now: the organization has Slack on, the persona's app
 * is in Slack, and the thread's member is still linked to a Slack user in the app's workspace and
 * still in the organization. Where not, nothing is, and the mark stays, so it goes on from there
 * once it is so again.
 */
export function deliversTo(place: Pick<SlackDelivery, 'org' | 'member' | 'app'>): boolean {
	if (!hasExperiment({experiments: organizationExperiments(place.org)}, 'slack')) {
		return false;
	}
	if (place.app.removedAt !== null || place.app.botToken === null) {
		return false;
	}
	return place.member.linked && place.member.inOrganization;
}

/**
 * What Slack saying no to a message comes to: wait as long as it says, or a while where it doesn't
 * say; the app's token no longer works, or the app is gone; the Slack thread or its channel is
 * gone; Slack won't take this message, as Markdown or at its size; or anything else, to be tried
 * again later.
 */
export type DeliveryFailure = {kind: 'rate_limited'; waitMs: number} | {kind: 'app_gone'} | {kind: 'thread_gone'; why: string} | {kind: 'message_refused'} | {kind: 'retry'};

// How long to wait on a rate limit that doesn't say.
const RATE_LIMIT_WAIT_MS = 30_000;

// What chat.postMessage answers where the DM or the Slack thread in it is gone: its channel, an
// archived one, a root that can't have replies; and, though its reference page doesn't list them,
// the names other methods give a thread or message that is gone.
const THREAD_GONE = ['channel_not_found', 'is_archived', 'cannot_reply_to_message', 'thread_not_found', 'message_not_found'];

// What chat.postMessage answers where it won't take this message as it is.
const MESSAGE_REFUSED = ['invalid_arguments', 'invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'msg_too_long', 'no_text', 'markdown_text_conflict'];

// Its rate limits as a code in the body: the app posting too much, or the workspace's members.
const RATE_LIMITED = ['rate_limited', 'ratelimited', 'message_limit_exceeded'];

/** What Slack's no to a message comes to. */
export function deliveryFailure(error: SlackError): DeliveryFailure {
	if (error.kind === 'rate_limited') {
		return {kind: 'rate_limited', waitMs: error.retryAfterSeconds === null ? RATE_LIMIT_WAIT_MS : error.retryAfterSeconds * 1000};
	}
	if (error.kind === 'unreachable') {
		return {kind: 'retry'};
	}
	if (RATE_LIMITED.includes(error.error)) {
		return {kind: 'rate_limited', waitMs: RATE_LIMIT_WAIT_MS};
	}
	if (isTokenGone(error)) {
		return {kind: 'app_gone'};
	}
	if (THREAD_GONE.includes(error.error)) {
		return {kind: 'thread_gone', why: error.error};
	}
	if (MESSAGE_REFUSED.includes(error.error)) {
		return {kind: 'message_refused'};
	}
	return {kind: 'retry'};
}

/** How many times a message is tried where Slack fails otherwise, before it is skipped. */
export const MAX_ATTEMPTS = 6;

// The wait before the first try again, doubled at each after.
const RETRY_BASE_MS = 5_000;

/** How long to wait before trying a message again, after `attempts` failed tries at it: 5 seconds, doubling, about two and a half minutes before the last. */
export function retryWaitMs(attempts: number): number {
	return RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0);
}
