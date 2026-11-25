import {describe, expect, test} from 'bun:test';

import type {ToolCall} from '@proxy/utils/harness';
import type {ShownEntryRow} from '@proxy/db/harness';
import type {SlackDelivery, SlackSubAgentRow} from '@proxy/db/slack-delivery';

import {deliversTo, deliveryFailure, markAfter, markPast, MAX_ATTEMPTS, outgoingOf, pastMark, retryWaitMs, type SlackOutgoing} from './delivery-rules';
import {SLACK_MARKDOWN_LIMIT} from './slack-markdown';

const APP = 'https://proxy.example.com';

let seq = 100;
function entry(fields: Partial<ShownEntryRow>): ShownEntryRow {
	seq += 1;
	return {id: `entry-${seq}`, seq, kind: 'assistant', pending: false, text: '', toolCalls: null, callId: null, isError: false, createdAt: new Date('2026-11-16T10:00:00Z'), ...fields};
}

const call = (name: string, args: object, id = 'call-1'): ToolCall => ({id, name, arguments: JSON.stringify(args)});

// A sub-agent the thread's agent started with its call `call-sub`.
const subAgent: SlackSubAgentRow = {id: 'sub-1', title: 'Fares to Lyon', parentCallId: 'call-sub'};

// What the entries come to in Slack, with the thread's sub-agent.
const posted = (entries: ShownEntryRow[]) => outgoingOf({entries, subAgents: [subAgent]}, APP).map(({markdown}) => markdown);

const DUE = 'The alert “Renewal” is due now, which you set for 2026-11-20T09:00:00.000Z. What you noted for it: Tell Dana the lease renews.';

describe('what a thread’s entries come to in Slack', () => {
	const cases: Array<[string, Partial<ShownEntryRow>, string[]]> = [
		['an answer, as written', {text: 'Booked the **9:40** to Lyon.'}, ['Booked the **9:40** to Lyon.']],
		['a message the agent sent as it went', {toolCalls: [call('send_to_person', {text: 'Looking at fares now.'})]}, ['Looking at fares now.']],
		[
			'an answer with words and a message sent in the same step, the words first',
			{text: 'Two options.', toolCalls: [call('search_fares', {to: 'Lyon'}, 'call-1'), call('send_to_person', {text: 'Checking seats too.'}, 'call-2')]},
			['Two options.', 'Checking seats too.'],
		],
		[
			'a failure, as written',
			{text: 'Something went wrong on my side, so I could not answer: the model is away. Say something to try again.', isError: true},
			['Something went wrong on my side, so I could not answer: the model is away. Say something to try again.'],
		],
		['an alert that fired, as the one line the Chat page reads it as, under its lead', {kind: 'event', text: DUE}, ['Alert: “Renewal” is due']],
		['what the member said, which they wrote in Slack, not again', {kind: 'person', text: 'Book the train'}, []],
		['anything pending, not yet', {kind: 'event', text: DUE, pending: true}, []],
		['a call that isn’t a message to the member, not at all', {toolCalls: [call('search_fares', {to: 'Lyon'})]}, []],
		['a sub-agent started, no line for it', {toolCalls: [call('create_subagent', {title: 'Fares to Lyon', brief: 'Find the fares'}, 'call-sub')]}, []],
		['a sub-agent written to, no line for it', {toolCalls: [call('send_to_subagent', {subagent: 'sub-1', text: 'Only direct trains'}, 'call-more')]}, []],
		['what a sub-agent said back, which the agent passes on, not at all', {kind: 'event', callId: 'call-sub', text: '“Fares to Lyon” (sub-1):\n\nThe 9:40 is cheapest.'}, []],
		['a call’s result, not at all', {kind: 'tool_result', text: '{"fares": []}'}, []],
		['a summary, not at all', {kind: 'summary', text: 'The member wants a train.'}, []],
		['an answer whose words are only files’ marks, nothing', {text: '\uFFFC'}, []],
	];

	for (const [name, fields, expected] of cases) {
		test(name, () => {
			const one = entry(fields);
			const messages = outgoingOf({entries: [one], subAgents: [subAgent]}, APP);
			expect(messages.map(({markdown}) => markdown)).toEqual(expected);
			expect(messages.map(({seq: at}) => at)).toEqual(expected.map(() => one.seq));
		});
	}

	test('keeps the words of an answer that started a sub-agent, and what it told the member, in order', () => {
		const one = entry({
			text: 'Looking into two things.',
			toolCalls: [call('create_subagent', {title: 'Fares to Lyon', brief: 'Find the fares'}, 'call-sub'), call('send_to_person', {text: 'Back in a minute.'}, 'call-2')],
		});
		expect(posted([one])).toEqual(['Looking into two things.', 'Back in a minute.']);
	});

	test('numbers an entry’s messages in order, its last marked', () => {
		const one = entry({text: 'Words.', toolCalls: [call('send_to_person', {text: 'Told.'})]});
		expect(outgoingOf({entries: [one], subAgents: []}, APP)).toEqual([
			{seq: one.seq, part: 0, last: false, markdown: 'Words.'},
			{seq: one.seq, part: 1, last: true, markdown: 'Told.'},
		]);
	});

	test('cuts a long answer into several, in order', () => {
		const paragraph = 'y'.repeat(SLACK_MARKDOWN_LIMIT - 10);
		const one = entry({text: `${paragraph}\n\n${paragraph}`});
		expect(outgoingOf({entries: [one], subAgents: []}, APP).map(({part, last, markdown}) => [part, last, markdown])).toEqual([
			[0, false, paragraph],
			[1, true, paragraph],
		]);
	});

	test('keeps entries in the order of the thread', () => {
		const first = entry({text: 'First.'});
		const second = entry({kind: 'event', text: 'Second'});
		expect(posted([first, second])).toEqual(['First.', 'Alert: Second']);
	});
});

describe('the mark', () => {
	const message = (at: number, part: number, last: boolean): SlackOutgoing => ({seq: at, part, last, markdown: `${at}:${part}`});
	const messages = [message(5, 0, true), message(7, 0, false), message(7, 1, false), message(7, 2, true), message(9, 0, true)];

	test('passes over what was delivered, and the messages of an entry part way through that were posted', () => {
		expect(pastMark(messages, {deliveredSeq: 0, partSeq: null, partsPosted: 0})).toEqual(messages);
		expect(pastMark(messages, {deliveredSeq: 5, partSeq: 7, partsPosted: 2}).map(({markdown}) => markdown)).toEqual(['7:2', '9:0']);
		expect(pastMark(messages, {deliveredSeq: 9, partSeq: null, partsPosted: 0})).toEqual([]);
	});

	test('moves past an entry with its last message, and part way through it with any other', () => {
		const start = {deliveredSeq: 5, partSeq: null, partsPosted: 0};
		expect(markAfter(message(7, 0, false), start)).toEqual({deliveredSeq: 5, partSeq: 7, partsPosted: 1});
		expect(markAfter(message(7, 2, true), {deliveredSeq: 5, partSeq: 7, partsPosted: 2})).toEqual({deliveredSeq: 7, partSeq: null, partsPosted: 0});
	});

	test('moves past every entry read once they are delivered, those not shown too', () => {
		const read = [entry({text: 'Shown.'}), entry({kind: 'tool_result', text: 'ok'})];
		const at = {deliveredSeq: read[0]?.seq ?? 0, partSeq: null, partsPosted: 0};
		expect(markPast(read, at)).toEqual({deliveredSeq: read[1]?.seq ?? 0, partSeq: null, partsPosted: 0});
		expect(markPast([], at)).toEqual(at);
	});
});

describe('where anything is delivered', () => {
	const place: Pick<SlackDelivery, 'org' | 'member' | 'app'> = {
		org: {experiments: ['slack'], insider: false},
		member: {linked: true, inOrganization: true},
		app: {id: 'app-1', botToken: 'enc:xoxb', removedAt: null, sessionsOffUntil: null},
	};
	const cases: Array<[string, Partial<typeof place>, boolean]> = [
		['an organization with Slack on, its member linked and in it', {}, true],
		['an insider organization', {org: {experiments: [], insider: true}}, true],
		['Slack off', {org: {experiments: [], insider: false}}, false],
		['the app removed', {app: {...place.app, removedAt: new Date()}}, false],
		['the app without a token', {app: {...place.app, botToken: null}}, false],
		['the member unlinked', {member: {linked: false, inOrganization: true}}, false],
		['the member gone from the organization', {member: {linked: true, inOrganization: false}}, false],
	];
	for (const [name, fields, delivers] of cases) {
		test(name, () => {
			expect(deliversTo({...place, ...fields})).toBe(delivers);
		});
	}
});

describe('Slack saying no', () => {
	const refused = (error: string) => ({kind: 'refused' as const, method: 'chat.postMessage', error, problems: []});
	const cases: Array<[string, Parameters<typeof deliveryFailure>[0], ReturnType<typeof deliveryFailure>]> = [
		['a rate limit, as long as it says', {kind: 'rate_limited', method: 'chat.postMessage', retryAfterSeconds: 12}, {kind: 'rate_limited', waitMs: 12_000}],
		['a rate limit that doesn’t say', {kind: 'rate_limited', method: 'chat.postMessage', retryAfterSeconds: null}, {kind: 'rate_limited', waitMs: 30_000}],
		['too many messages from the workspace', refused('message_limit_exceeded'), {kind: 'rate_limited', waitMs: 30_000}],
		['a revoked token', refused('token_revoked'), {kind: 'app_gone'}],
		['an inactive bot', refused('account_inactive'), {kind: 'app_gone'}],
		['a channel gone', refused('channel_not_found'), {kind: 'thread_gone', why: 'channel_not_found'}],
		['an archived channel', refused('is_archived'), {kind: 'thread_gone', why: 'is_archived'}],
		['a message it won’t take', refused('invalid_blocks'), {kind: 'message_refused'}],
		['a message too long', refused('msg_blocks_too_long'), {kind: 'message_refused'}],
		['Slack failing', refused('internal_error'), {kind: 'retry'}],
		['Slack away', {kind: 'unreachable', method: 'chat.postMessage', cause: {kind: 'timeout', url: 'https://slack.com/api/chat.postMessage', timeoutMs: 10_000}}, {kind: 'retry'}],
	];
	for (const [name, error, failure] of cases) {
		test(name, () => {
			expect(deliveryFailure(error)).toEqual(failure);
		});
	}

	test('waits longer at each try, to a limit', () => {
		expect(Array.from({length: MAX_ATTEMPTS - 1}, (_, index) => retryWaitMs(index + 1))).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
	});
});
