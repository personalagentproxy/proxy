import {pendingToolCalls, type ToolCall} from './harness';

/** The conversation as the model reads it, in the chat completions form. */
export type ModelMessage =
	| {role: 'system'; content: string}
	| {role: 'user'; content: string}
	| {
			role: 'assistant';
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: 'function';
				function: {name: string; arguments: string};
			}>;
	  }
	| {role: 'tool'; tool_call_id: string; content: string};

/** An entry of the log, as much of it as reading the log needs: its kind and text, its calls or the call it answers, its place, how far a summary reaches, and what an answer cost. */
export type ContextEntry = {
	kind: 'person' | 'assistant' | 'tool_result' | 'event' | 'summary';
	text: string;
	toolCalls: ToolCall[] | null;
	callId: string | null;
	isError: boolean;
	seq: number;
	coversSeq: number | null;
	inputTokens: number | null;
};

/**
 * The log as the model reads it, here rather than in the api so that the admin (the internal
 * repo) can rebuild what the model was sent from a log it reads. An event, what a sub-agent said to the agent that started it, is
 * read as a message, since it came on its own, after the call that started the sub-agent was
 * answered with its id; which sub-agent, by that call, is known from the thread's sub-agents
 * (`SubAgent`), given alongside the log. A log that has grown long
 * is summarized: a summary entry stands for every entry up to the one it covers, and the model
 * reads the summary, then what came since. Of that, the person's last turns are kept as said,
 * except what tools answered and what events brought in the turns before the current one, which
 * is cleared: it is the bulk, and the model can ask again. A log with one turn of the person, a
 * sub-agent's brief and the work on it, keeps its last steps instead. The log to be summarized
 * is given to the model as plain text, the calls and their answers written out.
 */

/** Once a request to the model was this many tokens, the log is summarized before the next. */
export const COMPACT_AT_TOKENS = 80_000;

// How many of the person's turns are kept behind a summary: the current one and the one before.
const KEEP_TURNS = 2;

// How many of the model's steps are kept behind a summary where the log has fewer turns of the
// person than that: a sub-agent's, one brief and the calls made on it.
const KEEP_STEPS = 3;

const SUMMARY_LEAD =
	'What came before in this conversation, summarized so that it fits. The person did not write this; take it as what happened.';

const CLEARED = '(This was cleared from the conversation to save room. Ask again if you need it.)';

/** A sub-agent of the thread, as much of it as the log needs: which call started it, its id and its title. */
export type SubAgent = {id: string; parentCallId: string | null; title: string | null};

// The call an entry answers, by the id the model gave it, found in the log.
function callOf(entries: ContextEntry[], callId: string | null): ToolCall | undefined {
	return entries
		.flatMap((entry) => entry.toolCalls ?? [])
		.find((candidate) => candidate.id === callId);
}

// How an event is led in: which sub-agent said it, by the call that started it.
function eventLead(subAgents: SubAgent[], event: ContextEntry): string {
	const from = subAgents.find((candidate) => candidate.parentCallId === event.callId);
	const who = from
		? `the sub-agent “${from.title ?? ''}” (id ${from.id})`
		: `your call ${event.callId ?? ''}`;
	if (event.isError) {
		return `What ${who} failed with. The person did not write this.`;
	}
	return `A message from ${who}. The person did not write this; it is for you to act on or tell them of.`;
}

function toMessage(subAgents: SubAgent[], entry: ContextEntry): ModelMessage {
	if (entry.kind === 'person') {
		return {role: 'user', content: entry.text};
	}
	if (entry.kind === 'tool_result') {
		return {role: 'tool', tool_call_id: entry.callId ?? '', content: entry.text};
	}
	if (entry.kind === 'event') {
		return {role: 'user', content: `${eventLead(subAgents, entry)}\n\n${entry.text}`};
	}
	if (entry.kind === 'summary') {
		return {role: 'user', content: `${SUMMARY_LEAD}\n\n${entry.text}`};
	}
	const calls = entry.toolCalls ?? [];
	return {
		role: 'assistant',
		content: entry.text === '' && calls.length > 0 ? null : entry.text,
		...(calls.length > 0
			? {
					tool_calls: calls.map((call) => ({
						id: call.id,
						type: 'function' as const,
						function: {name: call.name, arguments: call.arguments},
					})),
				}
			: {}),
	};
}

// The log from its last summary on: the summary, then the entries it doesn't cover, no other
// summary among them.
function sinceSummary(entries: ContextEntry[]): {
	summary: ContextEntry | null;
	tail: ContextEntry[];
} {
	const summary = entries.findLast((entry) => entry.kind === 'summary') ?? null;
	const covered = summary?.coversSeq ?? -1;
	return {
		summary,
		tail: entries.filter((entry) => entry.kind !== 'summary' && entry.seq > covered),
	};
}

/**
 * The log in the chat form, from its last summary on. With `clearOld`, what tools answered and
 * what events brought before the person's current turn is cleared, once there is a summary: that
 * is how the model reads a log, where a summary is made from the log as it is.
 */
export function toMessages(
	entries: ContextEntry[],
	subAgents: SubAgent[],
	{clearOld}: {clearOld: boolean},
): ModelMessage[] {
	const {summary, tail} = sinceSummary(entries);
	if (!summary) {
		return tail.map((entry) => toMessage(subAgents, entry));
	}
	const current = clearOld ? tail.findLastIndex((entry) => entry.kind === 'person') : -1;
	const bulky = (entry: ContextEntry) => entry.kind === 'tool_result' || entry.kind === 'event';
	return [
		toMessage(subAgents, summary),
		...tail.map((entry, index) =>
			bulky(entry) && index < current
				? toMessage(subAgents, {...entry, text: CLEARED})
				: toMessage(subAgents, entry),
		),
	];
}

// An entry as the transcript has it.
function toLine(entries: ContextEntry[], subAgents: SubAgent[], entry: ContextEntry): string {
	if (entry.kind === 'person') {
		return `Person:\n${entry.text}`;
	}
	if (entry.kind === 'tool_result') {
		return `${callOf(entries, entry.callId)?.name ?? 'The call'} answered${entry.isError ? ' with an error' : ''}:\n${entry.text}`;
	}
	if (entry.kind === 'event') {
		return `${eventLead(subAgents, entry)}\n${entry.text}`;
	}
	if (entry.kind === 'summary') {
		return `${SUMMARY_LEAD}\n${entry.text}`;
	}
	const calls = (entry.toolCalls ?? []).map(
		(call) => `Agent called ${call.name} with ${call.arguments}`,
	);
	return [...(entry.text === '' ? [] : [`Agent:\n${entry.text}`]), ...calls].join('\n');
}

/**
 * The log from its last summary on, as plain text, for the model to summarize: the calls and
 * what they answered written out, since a request that carries them as such has to carry the
 * tools too, which a summary needs none of.
 */
export function toTranscript(entries: ContextEntry[], subAgents: SubAgent[]): string {
	const {summary, tail} = sinceSummary(entries);
	return [...(summary ? [summary] : []), ...tail]
		.map((entry) => toLine(entries, subAgents, entry))
		.join('\n\n');
}

/**
 * How far a summary would reach, as the count of entries from the start it would cover: the log
 * before the person's last turns, or, where the person spoke but once, before the model's last
 * steps, cut so that no call is left without its result. Null when the log needs none: the last
 * request to the model was under the limit, or nothing since the last summary would be covered.
 */
export function compactionCut(entries: ContextEntry[]): number | null {
	const {summary, tail} = sinceSummary(entries);
	const lastAnswer = tail.findLast((entry) => entry.kind === 'assistant');
	if ((lastAnswer?.inputTokens ?? 0) < COMPACT_AT_TOKENS) {
		return null;
	}
	const turns = entries.flatMap((entry, index) => (entry.kind === 'person' ? [index] : []));
	const steps = entries.flatMap((entry, index) => (entry.kind === 'assistant' ? [index] : []));
	let cut = turns.at(-KEEP_TURNS) ?? steps.at(-KEEP_STEPS) ?? 0;
	while (cut > 0 && pendingToolCalls(entries.slice(0, cut)).length > 0) {
		cut -= 1;
	}
	const covered = summary?.coversSeq ?? -1;
	if (!entries.slice(0, cut).some((entry) => entry.kind !== 'summary' && entry.seq > covered)) {
		return null;
	}
	return cut;
}
