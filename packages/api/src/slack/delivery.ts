import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';

import {markSlackAppRemoved} from '@proxy/db/slack';
import {
	claimSlackDeliveries,
	claimSlackDelivery,
	dropSlackRoot,
	markSlackDelivered,
	noteSlackRoot,
	noteSlackRootTried,
	readSlackUndelivered,
	releaseSlackDelivery,
	type SlackDelivery,
	type SlackDeliveryMark,
	stopSlackDelivery,
} from '@proxy/db/slack-delivery';
import type {SlackSessionPlace} from '@proxy/db/slack-sessions';
import type {ShownEntryRow} from '@proxy/db/harness';

import {log, serializeError} from '../observability/log';
import {type DeliveryFailure, deliversTo, deliveryFailure, markAfter, markPast, MAX_ATTEMPTS, outgoingOf, pastMark, retryWaitMs, rootWaits, type SlackOutgoing} from './delivery-rules';
import {readBotToken} from './secrets';
import {RENEW_PROCESSING_MS} from './session-rules';
import {keepSession, type SessionStore, sessionStore} from './sessions';
import {findRootMessage, postMessage} from './slack-api';
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
 *
 * A thread opened in Slack begins with no Slack thread: by another of the member's threads, its
 * first message their words passed on; or by an alert set in a Slack thread, its first message the
 * alert's line. That message is posted at the top of the DM as its root, before anything else of
 * it, and the rest goes under it. One an alert opened waits until its agent's turn is over, as its
 * agent may dismiss it, which leaves nothing in Slack: its root is then never posted, and what it
 * said is passed over (delivery-rules.ts rootWaits). The root is posted once: after a try whose
 * answer never came, it is looked for in the DM, by the place its metadata names, before it is
 * tried again. Where it can't be posted at all, the thread lives in the app (`giveUpRoot`). A
 * thread another opened is delivered at once too (`deliverNow`), so its root is usually there by
 * the time the agent that opened it answers.
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
// How long a place whose root waits for its alert's turn to end is left before it is looked at again.
const ROOT_WAIT_MS = 3_000;

/** What the sweep needs of the database: to deliver, and to keep each place's session true. */
export type DeliveryStore = SessionStore & {
	claim: typeof claimSlackDeliveries;
	claimOne: typeof claimSlackDelivery;
	rootTried: typeof noteSlackRootTried;
	noteRoot: typeof noteSlackRoot;
	dropRoot: typeof dropSlackRoot;
	read: typeof readSlackUndelivered;
	mark: typeof markSlackDelivered;
	release: typeof releaseSlackDelivery;
	stop: typeof stopSlackDelivery;
	markAppRemoved: typeof markSlackAppRemoved;
};

export const deliveryStore: DeliveryStore = {
	...sessionStore,
	claim: claimSlackDeliveries,
	claimOne: claimSlackDelivery,
	rootTried: noteSlackRootTried,
	noteRoot: noteSlackRoot,
	dropRoot: dropSlackRoot,
	read: readSlackUndelivered,
	mark: markSlackDelivered,
	release: releaseSlackDelivery,
	stop: stopSlackDelivery,
	markAppRemoved: markSlackAppRemoved,
};

// What posting one message came to: posted, at its `ts`; skipped, as Slack took it neither as
// Markdown nor as plain text; or Slack's no.
type Posted = {kind: 'posted'; ts: string} | {kind: 'skipped'} | Exclude<DeliveryFailure, {kind: 'message_refused'}>;

// Where a message goes: the DM, under the thread's root, or at the top as its root, naming its place.
type PostAt = {channel: string; threadTs: string | null; place?: string};

// Posts the message as Markdown, and where Slack won't take it so, once as plain text.
async function postOne(token: string, place: SlackDelivery, at: PostAt, markdown: string): Promise<Posted> {
	const posted = await postMessage(token, {...at, markdown});
	if (posted.isOk()) {
		return {kind: 'posted', ts: posted.value.ts};
	}
	const failure = deliveryFailure(posted.error);
	if (failure.kind !== 'message_refused') {
		return failure;
	}
	const plain = await postMessage(token, {...at, text: toPlainSlackText(markdown)});
	if (plain.isOk()) {
		return {kind: 'posted', ts: plain.value.ts};
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

/**
 * Gives up the place of a thread opened in Slack whose root message can't be posted, so the thread
 * lives in the app, the reason only logged. Every way a root can't be posted comes here: the
 * organization has Slack off, the app is removed or not installed, the member isn't linked or left
 * the organization (deliversTo); the DM is gone; Slack takes the root in no form, or refused it on
 * every try; the message became another thread's root meanwhile; or there is nothing to post.
 */
async function giveUpRoot(store: DeliveryStore, workerId: string, place: SlackDelivery, why: string): Promise<void> {
	log.info('A thread opened in Slack can’t have its first message posted there; it lives in the app', {placeId: place.id, why});
	const dropped = await store.dropRoot(place.id, workerId);
	if (dropped.isErr()) {
		log.error('A thread whose first message can’t be posted in Slack could not be given to the app', {placeId: place.id, ...serializeError(dropped.error)});
	}
}

// What Slack's no to posting a root message, or to looking for it, comes to: the place left for
// as long as Slack says, or its app marked removed, after which the sweep gives the place up;
// given up where the DM is gone or every try failed; or tried again later.
async function afterRootFailure(store: DeliveryStore, workerId: string, place: SlackDelivery, failure: Exclude<DeliveryFailure, {kind: 'message_refused'}>): Promise<void> {
	if (failure.kind === 'rate_limited') {
		await release(store, workerId, place, failure.waitMs, place.attempts);
		return;
	}
	if (failure.kind === 'app_gone') {
		log.info('Slack no longer takes a persona’s app’s token; it is marked removed', {appId: place.app.id});
		const marked = await store.markAppRemoved(place.app.id);
		if (marked.isErr()) {
			log.error('A Slack app Slack no longer takes could not be marked removed', {appId: place.app.id, ...serializeError(marked.error)});
		}
		await release(store, workerId, place, 0, place.attempts);
		return;
	}
	if (failure.kind === 'thread_gone') {
		await giveUpRoot(store, workerId, place, failure.why);
		return;
	}
	const tried = place.attempts + 1;
	if (tried >= MAX_ATTEMPTS) {
		await giveUpRoot(store, workerId, place, `failed ${tried} times`);
		return;
	}
	await release(store, workerId, place, retryWaitMs(tried), tried);
}

// Notes the root message posted at `rootTs`, the mark past the message it is: the root and the
// mark, or null where it wasn't noted, given up where the message is another thread's root already.
async function noteRoot(store: DeliveryStore, workerId: string, place: SlackDelivery, rootTs: string, mark: SlackDeliveryMark): Promise<{rootTs: string; mark: SlackDeliveryMark} | null> {
	const noted = await store.noteRoot(place.id, workerId, rootTs, mark, LEASE_MS);
	if (noted.isErr()) {
		log.error('A thread’s root message in Slack could not be noted; it is looked for there again', {placeId: place.id, ...serializeError(noted.error)});
		return null;
	}
	if (noted.value === 'taken') {
		await giveUpRoot(store, workerId, place, 'its root became another thread’s');
		return null;
	}
	if (noted.value === 'lost') {
		log.warn('A Slack thread’s delivery was no longer this instance’s', {placeId: place.id});
		return null;
	}
	return {rootTs, mark};
}

/**
 * The place's root message, its first message `first`, at the top of the DM, as this module says:
 * found where an earlier try may have posted it, else posted, naming the place; with the mark past
 * it. Null where it isn't, for now or for good.
 */
async function postRoot(
	store: DeliveryStore,
	workerId: string,
	token: string,
	place: SlackDelivery,
	first: SlackOutgoing | undefined,
	mark: SlackDeliveryMark,
): Promise<{rootTs: string; mark: SlackDeliveryMark} | null> {
	if (first === undefined) {
		await giveUpRoot(store, workerId, place, 'nothing to post');
		return null;
	}
	if (place.rootTriedAt !== null) {
		const found = await findRootMessage(token, {channel: place.channel, place: place.id, since: place.rootTriedAt});
		if (found.isErr()) {
			const failure = deliveryFailure(found.error);
			await afterRootFailure(store, workerId, place, failure.kind === 'message_refused' ? {kind: 'retry'} : failure);
			return null;
		}
		if (found.value !== null) {
			return noteRoot(store, workerId, place, found.value, markAfter(first, mark));
		}
	}
	const tried = await store.rootTried(place.id, workerId);
	if (tried.isErr() || !tried.value) {
		log.warn('A thread’s root message in Slack could not be tried now', {placeId: place.id, ...(tried.isErr() ? serializeError(tried.error) : {})});
		return null;
	}
	const posted = await postOne(token, place, {channel: place.channel, threadTs: null, place: place.id}, first.markdown);
	if (posted.kind === 'skipped') {
		await giveUpRoot(store, workerId, place, 'Slack took it in no form');
		return null;
	}
	if (posted.kind !== 'posted') {
		await afterRootFailure(store, workerId, place, posted);
		return null;
	}
	return noteRoot(store, workerId, place, posted.ts, markAfter(first, mark));
}

// Whether the root of a place an alert opened is to wait, as rootWaits says, reading where its
// thread stands: `null` to post it now; otherwise the place is left a moment while the turn runs,
// or, the thread dismissed, its mark moved past what was read, so nothing of it is posted.
async function rootHeld(store: DeliveryStore, workerId: string, place: SlackDelivery, entries: ShownEntryRow[], mark: SlackDeliveryMark): Promise<boolean> {
	if (!place.thread.openedByAlert) {
		return false;
	}
	const read = await store.state(place.threadId, new Date());
	if (read.isErr()) {
		log.warn('Where a thread an alert opened stands could not be read to post its root in Slack', {placeId: place.id, ...serializeError(read.error)});
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return true;
	}
	const waits = read.value === null ? 'dismissed' : rootWaits(read.value);
	if (waits === 'post') {
		return false;
	}
	if (waits === 'at_work') {
		await release(store, workerId, place, ROOT_WAIT_MS, place.attempts);
		return true;
	}
	if (await moveMark(store, workerId, place, markPast(entries, mark))) {
		await release(store, workerId, place, 0, 0);
	}
	return true;
}

/**
 * Delivers what the thread said past the place's mark, as far as Slack takes it, its root message
 * first where it has none, then keeps its session true, and lets the place go. A place with no
 * root that nothing is delivered to now is given up, its thread to the app.
 */
export async function deliverPlace(store: DeliveryStore, workerId: string, appUrl: string, place: SlackDelivery): Promise<void> {
	if (!deliversTo(place)) {
		if (place.rootTs === null) {
			await giveUpRoot(store, workerId, place, 'Slack doesn’t take it now');
			return;
		}
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	const token = place.app.botToken === null ? null : readBotToken(place.app.botToken).unwrapOr(null);
	if (token === null) {
		log.warn('A Slack app’s bot token could not be read to deliver to it', {appId: place.app.id});
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	const mark: SlackDeliveryMark = {deliveredSeq: place.deliveredSeq, partSeq: place.partSeq, partsPosted: place.partsPosted};
	const due = await undelivered(store, place, appUrl, mark);
	if (due === null) {
		await release(store, workerId, place, ASIDE_MS, place.attempts);
		return;
	}
	if (place.rootTs !== null) {
		await deliverUnder(store, workerId, token, place, {...place, rootTs: place.rootTs}, due.messages, due.entries, mark);
		return;
	}
	if (await rootHeld(store, workerId, place, due.entries, mark)) {
		return;
	}
	const rooted = await postRoot(store, workerId, token, place, due.messages[0], mark);
	if (rooted === null) {
		return;
	}
	await deliverUnder(store, workerId, token, place, {...place, rootTs: rooted.rootTs}, due.messages.slice(1), due.entries, rooted.mark);
}

// Posts the messages in the Slack thread, moving the mark after each, then past every entry read,
// keeps the session true, and lets the place go.
async function deliverUnder(
	store: DeliveryStore,
	workerId: string,
	token: string,
	place: SlackDelivery,
	at: SlackSessionPlace,
	messages: SlackOutgoing[],
	entries: ShownEntryRow[],
	from: SlackDeliveryMark,
): Promise<void> {
	let mark = from;
	let attempts = place.attempts;
	for (const message of messages) {
		const outcome = await postOne(token, place, {channel: at.channel, threadTs: at.rootTs}, message.markdown);
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
	const past = markPast(entries, mark);
	if (!(await moveMark(store, workerId, place, past))) {
		return;
	}
	await keepSession(store, token, at, past.deliveredSeq);
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

// What this instance names itself when it delivers a place at once, apart from its sweep.
const NOW_WORKER = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}-now`;

/**
 * Delivers the place at once, as the sweep would, where it is free: for a thread just opened in
 * Slack from another, so its root message is posted while the agent that opened it is still at
 * work. Nothing where another instance holds it, which delivers it; a failure is logged, and the
 * sweep tries again.
 */
export async function deliverNow(placeId: string, appUrl: string, store: DeliveryStore = deliveryStore): Promise<void> {
	const claimed = await store.claimOne(placeId, NOW_WORKER, LEASE_MS);
	if (claimed.isErr()) {
		log.warn('A Slack thread could not be taken to deliver it at once', {placeId, ...serializeError(claimed.error)});
		return;
	}
	if (claimed.value === null) {
		return;
	}
	await deliverPlace(store, NOW_WORKER, appUrl, claimed.value);
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
