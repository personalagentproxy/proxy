import {DELEGATE_TOOL, delegateArgs, pendingToolCalls} from '@proxy/utils/harness';
import type {EntryRow} from '@proxy/db/harness';

import type {ModelMessage} from './model';

/**
 * The log as the model reads it. An event, a sub-agent's report, is read as a message, since it
 * came on its own, after the call it answers was answered as started. A log that has grown long
 * is summarized: a summary entry stands for every entry up to the one it covers, and the model
 * reads the summary, then what came since. Of that, the person's last turns are kept as said,
 * except what tools answered and what events brought in the turns before the current one, which
 * is cleared: it is the bulk, and the model can ask again.
 */

/** Once a request to the model was this many tokens, the log is summarized before the next. */
export const COMPACT_AT_TOKENS = 80_000;

// How many of the person's turns are kept behind a summary: the current one and the one before.
const KEEP_TURNS = 2;

const SUMMARY_LEAD = 'What came before in this conversation, summarized so that it fits. The person did not write this; take it as what happened.';

const CLEARED = '(This was cleared from the conversation to save room. Ask again if you need it.)';

// How an event is led in: whose report it is, by the call it answers, found in the log.
function eventLead(entries: EntryRow[], event: EntryRow): string {
	const call = entries.flatMap((entry) => entry.toolCalls ?? []).find((candidate) => candidate.id === event.callId);
	const parsed = call?.name === DELEGATE_TOOL ? delegateArgs(JSON.parse(call.arguments)) : null;
	const who = parsed ? `the sub-agent “${parsed.title}”` : `your call ${event.callId ?? ''}`;
	if (event.isError) {
		return `What ${who} failed with. The person did not write this.`;
	}
	return `The report of ${who}. The person did not write this; it is for you to act on or tell them of.`;
}

function toMessage(entries: EntryRow[], entry: EntryRow): ModelMessage {
	if (entry.kind === 'person') {
		return {role: 'user', content: entry.text};
	}
	if (entry.kind === 'tool_result') {
		return {role: 'tool', tool_call_id: entry.callId ?? '', content: entry.text};
	}
	if (entry.kind === 'event') {
		return {role: 'user', content: `${eventLead(entries, entry)}\n\n${entry.text}`};
	}
	if (entry.kind === 'summary') {
		return {role: 'user', content: `${SUMMARY_LEAD}\n\n${entry.text}`};
	}
	const calls = entry.toolCalls ?? [];
	return {
		role: 'assistant',
		content: entry.text === '' && calls.length > 0 ? null : entry.text,
		...(calls.length > 0 ? {tool_calls: calls.map((call) => ({id: call.id, type: 'function' as const, function: {name: call.name, arguments: call.arguments}}))} : {}),
	};
}

// The log from its last summary on: the summary, then the entries it doesn't cover, no other
// summary among them.
function sinceSummary(entries: EntryRow[]): {summary: EntryRow | null; tail: EntryRow[]} {
	const summary = entries.findLast((entry) => entry.kind === 'summary') ?? null;
	const covered = summary?.coversSeq ?? -1;
	return {summary, tail: entries.filter((entry) => entry.kind !== 'summary' && entry.seq > covered)};
}

/**
 * The log in the chat form, from its last summary on. With `clearOld`, what tools answered and
 * what events brought before the person's current turn is cleared, once there is a summary: that
 * is how the model reads a log, where a summary is made from the log as it is.
 */
export function toMessages(entries: EntryRow[], {clearOld}: {clearOld: boolean}): ModelMessage[] {
	const {summary, tail} = sinceSummary(entries);
	if (!summary) {
		return tail.map((entry) => toMessage(entries, entry));
	}
	const current = clearOld ? tail.findLastIndex((entry) => entry.kind === 'person') : -1;
	const bulky = (entry: EntryRow) => entry.kind === 'tool_result' || entry.kind === 'event';
	return [toMessage(entries, summary), ...tail.map((entry, index) => (bulky(entry) && index < current ? toMessage(entries, {...entry, text: CLEARED}) : toMessage(entries, entry)))];
}

/**
 * How far a summary would reach, as the count of entries from the start it would cover: the log
 * before the person's last turns, cut so that no call is left without its result. Null when the
 * log needs none: the last request to the model was under the limit, or nothing since the last
 * summary would be covered.
 */
export function compactionCut(entries: EntryRow[]): number | null {
	const {summary, tail} = sinceSummary(entries);
	const lastAnswer = tail.findLast((entry) => entry.kind === 'assistant');
	if ((lastAnswer?.inputTokens ?? 0) < COMPACT_AT_TOKENS) {
		return null;
	}
	const turns = entries.flatMap((entry, index) => (entry.kind === 'person' ? [index] : []));
	let cut = turns.at(-KEEP_TURNS) ?? 0;
	while (cut > 0 && pendingToolCalls(entries.slice(0, cut)).length > 0) {
		cut -= 1;
	}
	const covered = summary?.coversSeq ?? -1;
	if (!entries.slice(0, cut).some((entry) => entry.kind !== 'summary' && entry.seq > covered)) {
		return null;
	}
	return cut;
}
