import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';

import {markSlackAppRemoved} from '@proxy/db/slack';
import {claimSlackDeliveries, markSlackDelivered, readSlackUndelivered, releaseSlackDelivery, type SlackDelivery, type SlackDeliveryMark, stopSlackDelivery} from '@proxy/db/slack-delivery';

import {log, serializeError} from '../observability/log';
import {type DeliveryFailure, deliversTo, deliveryFailure, markAfter, markPast, MAX_ATTEMPTS, outgoingOf, pastMark, retryWaitMs} from './delivery-rules';
import {readBotToken} from './secrets';
import {RENEW_PROCESSING_MS} from './session-rules';
import {keepSession, type SessionStore, sessionStore} from './sessions';
import {postMessage} from './slack-api';
import {toPlainSlackText} from './slack-markdown';

/**
 * Delivery to Slack, in each api instance: every second the sweep takes the threads' places in
 * Slack with anything past their mark (`claimSlackDeliveries`), each held for this instance a
 * minute, so no two instances post in one Slack thread at once, and posts what each thread said
 * since, as delivery-rules.ts makes it, in order, in the Slack thread under its root message,
 * moving the place's mark after each message Slack takes, which holds it a minute more. Places are
 * posted to side by side, each its messages one after the other, so one Slack is slow with, or asks
 * to wait, holds up no other. A message is posted at least once: the only repeat is one Slack took
 * as the answer never came back, which is tried again. Once everything due is posted, the place's
 * Slack session is set to where its thread stands, and given its title, where that changed
 * (sessions.ts). The api starts the sweep, and stops it as it stops (index.ts).
 */

// How often the places with anything to deliver are looked for, how many one sweep takes at most,
// how long one is held for its sweep, and how many entries of a thread one turn reads.
const SWEEP_MS = 1_000;
const SWEEP_LIMIT = 20;
const LEASE_MS = 60_000;
const READ_LIMIT = 50;
// How long a place nothing is delivered to now, as its member isn't linked, is left before it is
// looked at again; and one that failed on our side.
const ASIDE_MS = 60_000;

/** What the sweep needs of the database: to deliver, and to keep each place's session true. */
export type DeliveryStore = SessionStore & {
	claim: typeof claimSlackDeliveries;
	read: typeof readSlackUndelivered;
	mark: typeof markSlackDelivered;
	release: typeof releaseSlackDelivery;
	stop: typeof stopSlackDelivery;
	markAppRemoved: typeof markSlackAppRemoved;
};

export const deliveryStore: DeliveryStore = {
	...sessionStore,
	claim: claimSlackDeliveries,
	read: readSlackUndelivered,
	mark: markSlackDelivered,
	release: releaseSlackDelivery,
	stop: stopSlackDelivery,
	markAppRemoved: markSlackAppRemoved,
};

// What posting one message came to: posted; skipped, as Slack took it neither as Markdown nor as
// plain text; or Slack's no.
type Posted = {kind: 'posted'} | {kind: 'skipped'} | Exclude<DeliveryFailure, {kind: 'message_refused'}>;

// Posts the message as Markdown, and where Slack won't take it so, once as plain text.
async function postOne(token: string, place: SlackDelivery, markdown: string): Promise<Posted> {
	const at = {channel: place.channel, threadTs: place.rootTs};
	const posted = await postMessage(token, {...at, markdown});
	if (posted.isOk()) {
		return {kind: 'posted'};
	}
	const failure = deliveryFailure(posted.error);
	if (failure.kind !== 'message_refused') {
		return failure;
	}
	const plain = await postMessage(token, {...at, text: toPlainSlackText(markdown)});
	if (plain.isOk()) {
		return {kind: 'posted'};
	}
	const plainFailure = deliveryFailure(plain.error);
	if (plainFailure.kind !== 'message_refused') {
		return plainFailure;
	}
	log.warn('Slack took a message neither as Markdown nor as plain text; it is skipped', {placeId: place.id, error: plain.error.kind === 'refused' ? plain.error.error : plain.error.kind});
	return {kind: 'skipped'};
}

// Lets the place go, logging where that failed: it is taken again once its hold runs out.
async function release(store: DeliveryStore, workerId: string, place: SlackDelivery, delayMs: number, attempts: number): Promise<void> {
	const released = await store.release(place.id, workerId, delayMs, attempts);
	if (released.isErr()) {
		log.warn('A Slack thread’s delivery could not be let go', {placeId: place.id, ...serializeError(released.error)});
	}
}

// What a failure that isn't the message's own comes to, after `attempts` failed tries at it before
// this one: the place left for as long as Slack says, or stopped, or its app marked removed; or the
// message tried again later, or skipped after the last try (`true`, the mark to move past it).
async function afterFailure(store: DeliveryStore, workerId: string, place: SlackDelivery, failure: Exclude<DeliveryFailure, {kind: 'message_refused'}>, attempts: number): Promise<boolean> {
	if (failure.kind === 'rate_limited') {
		await release(store, workerId, place, failure.waitMs, attempts);
		return false;
	}
	if (failure.kind === 'app_gone') {
		log.info('Slack no longer takes a persona’s app’s token; it is marked removed', {appId: place.app.id});
		const marked = await store.markAppRemoved(place.app.id);
		if (marked.isErr()) {
			log.error('A Slack app Slack no longer takes could not be marked removed', {appId: place.app.id, ...serializeError(marked.error)});
		}
		await release(store, workerId, place, 0, attempts);
		return false;
	}
	if (failure.kind === 'thread_gone') {
		log.info('A thread’s place in Slack is gone; nothing more is delivered to it', {placeId: place.id, why: failure.why});
		const stopped = await store.stop(place.id, workerId, failure.why);
		if (stopped.isErr()) {
			log.warn('A Slack thread that is gone could not be marked so', {placeId: place.id, ...serializeError(stopped.error)});
		}
		return false;
	}
	const tried = attempts + 1;
	if (tried >= MAX_ATTEMPTS) {
		log.warn('A message could not be posted in Slack after every try; it is skipped', {placeId: place.id, attempts: tried});
		return true;
	}
	await release(store, workerId, place, retryWaitMs(tried), tried);
	return false;
}

// The messages past the place's mark, with the thread's entries read; null where they couldn't be.
async function undelivered(store: DeliveryStore, place: SlackDelivery, appUrl: string, mark: SlackDeliveryMark) {
	const read = await store.read(place.threadId, place.deliveredSeq, READ_LIMIT);
	if (read.isErr()) {
		log.warn('A thread could not be read to deliver it to Slack', {placeId: place.id, ...serializeError(read.error)});
		return null;
	}
	return {entries: read.value.entries, messages: pastMark(outgoingOf(read.value, appUrl), mark)};
}

/** Delivers what the thread said past the place's mark, as far as Slack takes it, then keeps its session true, and lets the place go. */
export async function deliverPlace(store: DeliveryStore, workerId: string, appUrl: string, place: SlackDelivery): Promise<void> {
	if (!deliversTo(place)) {
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	const token = place.app.botToken === null ? null : readBotToken(place.app.botToken).unwrapOr(null);
	if (token === null) {
		log.warn('A Slack app’s bot token could not be read to deliver to it', {appId: place.app.id});
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	let mark: SlackDeliveryMark = {deliveredSeq: place.deliveredSeq, partSeq: place.partSeq, partsPosted: place.partsPosted};
	const due = await undelivered(store, place, appUrl, mark);
	if (due === null) {
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	let attempts = place.attempts;
	for (const message of due.messages) {
		const outcome = await postOne(token, place, message.markdown);
		const passed = outcome.kind === 'posted' || outcome.kind === 'skipped' || (await afterFailure(store, workerId, place, outcome, attempts));
		if (!passed) {
			return;
		}
		const next = markAfter(message, mark);
		if (!(await moveMark(store, workerId, place, next))) {
			return;
		}
		mark = next;
		attempts = 0;
	}
	const past = markPast(due.entries, mark);
	if (!(await moveMark(store, workerId, place, past))) {
		return;
	}
	await keepSession(store, token, place, past.deliveredSeq);
	await release(store, workerId, place, 0, 0);
}

// Moves the place's mark; false where it is no longer this instance's, or couldn't be moved, and
// nothing more is posted for it now.
async function moveMark(store: DeliveryStore, workerId: string, place: SlackDelivery, mark: SlackDeliveryMark): Promise<boolean> {
	const moved = await store.mark(place.id, workerId, mark, LEASE_MS);
	if (moved.isErr()) {
		log.error('A Slack thread’s delivery mark could not be moved', {placeId: place.id, ...serializeError(moved.error)});
		return false;
	}
	if (!moved.value) {
		log.warn('A Slack thread’s delivery was no longer this instance’s', {placeId: place.id});
	}
	return moved.value;
}

/** One sweep: the places with anything to deliver, each delivered, side by side. */
export async function sweepSlackDeliveries(store: DeliveryStore, workerId: string, appUrl: string): Promise<void> {
	const claimed = await store.claim(workerId, LEASE_MS, SWEEP_LIMIT, RENEW_PROCESSING_MS);
	if (claimed.isErr()) {
		log.error('The Slack delivery sweep could not take the places due', serializeError(claimed.error));
		return;
	}
	await Promise.all(claimed.value.map((place) => deliverPlace(store, workerId, appUrl, place)));
}

export type SlackDeliverer = {stop: () => void};

/** Starts the sweep, as an instance named on its own; it runs until stopped. */
export function startSlackDeliverer(appUrl: string, store: DeliveryStore = deliveryStore): SlackDeliverer {
	const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) {
			return;
		}
		running = true;
		await sweepSlackDeliveries(store, workerId, appUrl).catch((error: unknown) => log.error('The Slack delivery sweep failed', serializeError(error)));
		running = false;
	};
	const timer = setInterval(() => void tick(), SWEEP_MS);
	void tick();
	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
