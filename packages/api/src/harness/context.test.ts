import {describe, expect, test} from 'bun:test';

import type {EntryRow} from '@proxy/db/harness';

import {COMPACT_AT_TOKENS, compactionCut, toMessages, toTranscript} from './context';

const now = new Date('2026-10-21T10:00:00Z');

type Kind = EntryRow['kind'];

function entry(seq: number, kind: Kind, text: string, extra: Partial<Pick<EntryRow, 'toolCalls' | 'callId' | 'inputTokens' | 'coversSeq'>> = {}): EntryRow {
	return {
		id: `e${seq}`,
		seq,
		threadId: 'thread-1',
		kind,
		pending: false,
		text,
		toolCalls: extra.toolCalls ?? null,
		callId: extra.callId ?? null,
		isError: false,
		inputTokens: extra.inputTokens ?? null,
		outputTokens: null,
		coversSeq: extra.coversSeq ?? null,
		createdAt: now,
	};
}

const read = (seq: number, id: string, inputTokens = 10) => entry(seq, 'assistant', '', {toolCalls: [{id, name: 'read', arguments: '{}'}], inputTokens});
const result = (seq: number, id: string, text = 'rows') => entry(seq, 'tool_result', text, {callId: id});

// Three turns of the person, each answered after a read.
const long = [
	entry(1, 'person', 'One'),
	read(2, 'c1'),
	result(3, 'c1', 'rows one'),
	entry(4, 'assistant', 'Done one', {inputTokens: 10}),
	entry(5, 'person', 'Two'),
	read(6, 'c2'),
	result(7, 'c2', 'rows two'),
	entry(8, 'assistant', 'Done two', {inputTokens: 10}),
	entry(9, 'person', 'Three'),
	read(10, 'c3', COMPACT_AT_TOKENS),
	result(11, 'c3', 'rows three'),
];

describe('toMessages', () => {
	test('gives the log in the chat form, as it is, where it has no summary', () => {
		expect(toMessages(long.slice(0, 4), {clearOld: true})).toEqual([
			{role: 'user', content: 'One'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: 'rows one'},
			{role: 'assistant', content: 'Done one'},
		]);
	});

	test('reads the last summary in place of what it covers, and clears the results of turns before the current one', () => {
		const log = [...long, entry(12, 'summary', 'The person asked for one.', {coversSeq: 4})];

		const messages = toMessages(log, {clearOld: true});

		expect(messages[0]).toEqual({role: 'user', content: expect.stringContaining('The person asked for one.')});
		expect(String(messages[0]?.content)).toContain('The person did not write this');
		expect(messages.slice(1)).toEqual([
			{role: 'user', content: 'Two'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c2', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c2', content: expect.stringContaining('cleared')},
			{role: 'assistant', content: 'Done two'},
			{role: 'user', content: 'Three'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c3', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c3', content: 'rows three'},
		]);
		expect(toMessages(log, {clearOld: false})[3]).toEqual({role: 'tool', tool_call_id: 'c2', content: 'rows two'});
	});

	test('reads a sub-agent’s report as a message, led in with whose it is, and clears old ones too', () => {
		const delegated = entry(1, 'person', 'Find my invoices');
		const call = entry(2, 'assistant', 'Looking.', {toolCalls: [{id: 'd1', name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}], inputTokens: 10});
		const started = entry(3, 'tool_result', 'Started.', {callId: 'd1'});
		const report = entry(4, 'event', 'Three invoices from Dana.', {callId: 'd1'});
		const failed = {...entry(5, 'event', 'The sub-agent failed: boom', {callId: 'd1'}), isError: true};

		const messages = toMessages([delegated, call, started, report, failed], {clearOld: true});

		expect(messages[3]).toEqual({role: 'user', content: expect.stringContaining('The report of the sub-agent “Find the invoices”')});
		expect(String(messages[3]?.content)).toContain('Three invoices from Dana.');
		expect(messages[4]).toEqual({role: 'user', content: expect.stringContaining('What the sub-agent “Find the invoices” failed with')});

		const later = [
			delegated,
			call,
			started,
			report,
			entry(6, 'assistant', 'Three invoices.', {inputTokens: 10}),
			entry(7, 'person', 'Thanks'),
			entry(8, 'summary', 'Invoices were found.', {coversSeq: 1}),
		];
		const cleared = toMessages(later, {clearOld: true});
		expect(String(cleared[3]?.content)).toContain('cleared');
		expect(String(cleared[3]?.content)).not.toContain('Dana');
	});

	test('leads a report in by the call where the delegation’s arguments were not JSON', () => {
		const call = entry(2, 'assistant', '', {toolCalls: [{id: 'd1', name: 'delegate', arguments: '{"title":'}], inputTokens: 10});
		const messages = toMessages([entry(1, 'person', 'Go'), call, entry(3, 'tool_result', 'Started.', {callId: 'd1'}), entry(4, 'event', 'Done.', {callId: 'd1'})], {clearOld: true});
		expect(messages[3]).toEqual({role: 'user', content: expect.stringContaining('The report of your call d1')});
	});

	test('with summaries on summaries, only the last counts', () => {
		const log = [...long, entry(12, 'summary', 'First.', {coversSeq: 4}), entry(13, 'summary', 'Second.', {coversSeq: 8})];

		const messages = toMessages(log, {clearOld: true});

		expect(String(messages[0]?.content)).toContain('Second.');
		expect(messages).toHaveLength(4);
		expect(messages[1]).toEqual({role: 'user', content: 'Three'});
	});
});

describe('compactionCut', () => {
	test('is nothing while the last request was under the limit', () => {
		expect(compactionCut(long.slice(0, 8))).toBeNull();
	});

	test('covers the log before the person’s last two turns once a request was over the limit', () => {
		expect(compactionCut(long)).toBe(4);
	});

	test('is nothing where the last turns are the whole log', () => {
		expect(compactionCut([entry(1, 'person', 'One'), read(2, 'c1', COMPACT_AT_TOKENS), result(3, 'c1')])).toBeNull();
	});

	test('moves back so that no call is left without its result', () => {
		// The person spoke while a read was still running: its result is after their message.
		const log = [
			entry(1, 'person', 'One'),
			entry(2, 'assistant', 'Ok', {inputTokens: 10}),
			entry(3, 'person', 'Two'),
			read(4, 'c1'),
			entry(5, 'person', 'Three'),
			result(6, 'c1'),
			entry(7, 'assistant', 'Done', {inputTokens: 10}),
			entry(8, 'person', 'Four'),
			read(9, 'c2', COMPACT_AT_TOKENS),
			result(10, 'c2'),
		];
		expect(compactionCut(log)).toBe(3);
	});

	test('is nothing again right after a summary, until a request since was over the limit', () => {
		const summarized = [...long, entry(12, 'summary', 'So far.', {coversSeq: 4})];
		expect(compactionCut(summarized)).toBeNull();

		const grown = [
			...summarized,
			entry(13, 'assistant', 'Done three', {inputTokens: 10}),
			entry(14, 'person', 'Four'),
			entry(15, 'assistant', 'Ok', {inputTokens: COMPACT_AT_TOKENS}),
			entry(16, 'person', 'Five'),
		];
		expect(compactionCut(grown)).toBe(13);
	});

	test('covers a log with one turn of the person, a sub-agent’s brief, before the model’s last three steps', () => {
		const log = [
			entry(1, 'person', 'Search the mailbox.'),
			read(2, 'c1'),
			result(3, 'c1'),
			read(4, 'c2'),
			result(5, 'c2'),
			read(6, 'c3'),
			result(7, 'c3'),
			read(8, 'c4', COMPACT_AT_TOKENS),
			result(9, 'c4'),
		];
		expect(compactionCut(log)).toBe(3);

		const summarized = [...log, entry(10, 'summary', 'Two reads so far.', {coversSeq: 3}), read(11, 'c5', COMPACT_AT_TOKENS), result(12, 'c5')];
		expect(compactionCut(summarized)).toBe(5);
	});
});

describe('toTranscript', () => {
	test('writes the log out as text from its last summary on, the calls, their answers and the reports with whose they are', () => {
		const delegated = entry(1, 'person', 'Find my invoices');
		const call = entry(2, 'assistant', 'Looking.', {toolCalls: [{id: 'd1', name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}], inputTokens: 10});
		const started = entry(3, 'tool_result', 'Started.', {callId: 'd1'});
		const report = entry(4, 'event', 'Three invoices from Dana.', {callId: 'd1'});
		const failed = {...entry(5, 'tool_result', 'No such tool.', {callId: 'x9'}), isError: true};

		expect(toTranscript([delegated, call, started, report, failed])).toBe(
			[
				'Person:\nFind my invoices',
				'Agent:\nLooking.\nAgent called delegate with {"title":"Find the invoices","brief":"Search the mailbox."}',
				'delegate answered:\nStarted.',
				'The report of the sub-agent “Find the invoices”. The person did not write this; it is for you to act on or tell them of.\nThree invoices from Dana.',
				'The call answered with an error:\nNo such tool.',
			].join('\n\n'),
		);

		const transcript = toTranscript([...long, entry(12, 'summary', 'The person asked for one.', {coversSeq: 4})]);
		expect(transcript.startsWith('What came before in this conversation')).toBe(true);
		expect(transcript).toContain('The person asked for one.\n\nPerson:\nTwo');
		expect(transcript).not.toContain('rows one');
	});
});
