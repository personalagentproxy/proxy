import {formatBytes} from './bytes';
import {ATTACHMENT_MARK, pendingToolCalls, type ToolCall} from './harness';

/** A part of what the person said where it is more than words: words, or a picture, as a data URL. */
export type ModelContentPart =
	{type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}};

/** The conversation as the model reads it, in the chat completions form: what the person said is words, or words and pictures in parts. */
export type ModelMessage =
	| {role: 'system'; content: string}
	| {role: 'user'; content: string | ModelContentPart[]}
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

/**
 * A picture the person attached, as a model that sees pictures is given it with what they said:
 * its file's name, its media type and its bytes in base64, made small enough to send.
 */
export type EntryImage = {
	name: string;
	mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
	data: string;
};

/** An entry of the log, as much of it as reading the log needs: its kind and text, its calls or the call it answers, its place, how far a summary reaches, and what an answer cost; and, for what the person said, the pictures they attached that the model is to see with it. */
export type ContextEntry = {
	kind: 'person' | 'assistant' | 'tool_result' | 'event' | 'summary' | 'note';
	text: string;
	images?: EntryImage[];
	toolCalls: ToolCall[] | null;
	callId: string | null;
	isError: boolean;
	// A sub-agent's person entry the member wrote in its chat, rather than the agent it works for.
	direct: boolean;
	seq: number;
	coversSeq: number | null;
	inputTokens: number | null;
};

/**
 * The log as the model reads it, here rather than in the api so that the admin (the internal
 * repo) can rebuild what the model was sent from a log it reads. An event, what a sub-agent said to the agent that started it, is
 * read as a message, since it came on its own, after the call that started the sub-agent was
 * answered with its id; which sub-agent, by that call, is known from the thread's sub-agents
 * (`SubAgent`), given alongside the log. An alert's event answers no call. A log that has grown long
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

const SUMMARY_LEAD = 'A summary of what came before; not from the person.';

const CLEARED = '(This was cleared from the conversation to save room. Ask again if you need it.)';

/** A sub-agent of the thread, as much of it as the log needs: which call started it, its id and its title. */
export type SubAgent = {id: string; parentCallId: string | null; title: string | null};

// The call an entry answers, by the id the model gave it, found in the log.
function callOf(entries: ContextEntry[], callId: string | null): ToolCall | undefined {
	return entries
		.flatMap((entry) => entry.toolCalls ?? [])
		.find((candidate) => candidate.id === callId);
}

/**
 * How an event is led in, for the model: which sub-agent said it, by the call that started it; an
 * alert's, which answers no call. Exported for a harness that renders the log as text itself, so
 * the model reads an event the same way on every harness.
 */
export function eventLead(subAgents: SubAgent[], event: ContextEntry): string {
	if (event.callId === null) {
		return 'An alert you set; not from the person.';
	}
	const from = subAgents.find((candidate) => candidate.parentCallId === event.callId);
	const who = from
		? `the sub-agent “${from.title ?? ''}” (${from.id})`
		: `your call ${event.callId ?? ''}`;
	if (event.isError) {
		return `${who} failed; not from the person.`;
	}
	return `From ${who}; not from the person.`;
}

/**
 * How what the person wrote in a sub-agent's chat is led in, for the model: in the sub-agent's
 * thread, as theirs rather than the agent's it works for; in the conversation, as a note of what
 * they wrote to which sub-agent, by the call that started it. Null for what is led in as nothing
 * but itself. Exported for a harness that renders the log as text itself.
 */
export function directLead(subAgents: SubAgent[], entry: ContextEntry): string | null {
	if (entry.kind === 'person' && entry.direct) {
		return 'From the person themselves, written in your chat, where they see what you answer; not from the agent you work for.';
	}
	if (entry.kind !== 'note') {
		return null;
	}
	const to = subAgents.find((candidate) => candidate.parentCallId === entry.callId);
	const who = to ? `the sub-agent “${to.title ?? ''}” (${to.id})` : 'one of your sub-agents';
	return `The person wrote this to ${who} themselves, in its chat, where they see what it answers; not to you. Its answer comes to you as its messages do.`;
}

// The entry's text, led in where it is what the person wrote in a sub-agent's chat.
function directText(subAgents: SubAgent[], entry: ContextEntry, gap: string): string {
	const lead = directLead(subAgents, entry);
	return lead === null ? entry.text : `${lead}${gap}${entry.text}`;
}

// What the person said with pictures: each picture under its file's name, then their words.
function withPictures(text: string, images: EntryImage[]): ModelContentPart[] {
	return [
		...images.flatMap((image): ModelContentPart[] => [
			{type: 'text', text: `${image.name}:`},
			{type: 'image_url', image_url: {url: `data:${image.mediaType};base64,${image.data}`}},
		]),
		{type: 'text', text},
	];
}

function toMessage(subAgents: SubAgent[], entry: ContextEntry): ModelMessage {
	if (entry.kind === 'person' || entry.kind === 'note') {
		const text = directText(subAgents, entry, '\n\n');
		const images = entry.images ?? [];
		return {role: 'user', content: images.length === 0 ? text : withPictures(text, images)};
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

/** Whether the entry is an answer of nothing: no words and no calls. */
export function isSilent(entry: ContextEntry): boolean {
	return entry.kind === 'assistant' && entry.text === '' && (entry.toolCalls ?? []).length === 0;
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
	const {summary, tail: all} = sinceSummary(entries);
	// An answer of nothing, as the agent talking with the person may give, isn't sent again: a
	// model's message has to say something or make a call.
	const tail = all.filter((entry) => !isSilent(entry));
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
	if (entry.kind === 'person' || entry.kind === 'note') {
		return `Person:\n${directText(subAgents, entry, '\n')}`;
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
	return [...(summary ? [summary] : []), ...tail.filter((entry) => !isSilent(entry))]
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

/**
 * A file the person attached to what they said: one of a drive's, by its connection and its id
 * there, at the version it held then, with its name, kind and size as they were, and the first of
 * its text where it is text, `cut` where there was more.
 */
export type EntryAttachment = {
	connectionId: string;
	fileId: string;
	version: string;
	name: string;
	type: string;
	size: number;
	text: string | null;
	cut: boolean;
};

function attachmentLines(attachment: EntryAttachment, pictured: boolean): string {
	const {name, type, size, connectionId, fileId, version, text, cut} = attachment;
	const what = `${name} (${type}, ${formatBytes(size)}): connection ${connectionId}, id ${fileId}, version ${version}.`;
	if (pictured) {
		return `${what} A picture, shown to you with this message.`;
	}
	// One of an earlier turn, or one that couldn't be read as a picture, or any for a model that
	// sees none.
	if (type.startsWith('image/')) {
		return `${what} A picture, not shown to you here.`;
	}
	if (text === null) {
		return `${what} Not text, so nothing of it is here.`;
	}
	if (text === '') {
		return `${what} It is empty.`;
	}
	const said = cut ? 'The first of its text, files_read having the rest:' : 'Its text:';
	return `${what} ${said}\n"""\n${text}\n"""`;
}

/**
 * What the person said as the model reads it where they attached files: their words, with each
 * file's name in brackets where they put it among them (`ATTACHMENT_MARK`), then each file, with
 * what names it for a read of the rest and what it holds as far as it was kept. A file among
 * `pictured` is a picture the model is given with the message, and is said to be. The files are
 * theirs, in a drive of Personal Agent Proxy's; what a file says is what a record says,
 * information. Here, as the log's reading is, so whoever rebuilds what the model was sent reads a
 * message the same way.
 */
export function withAttachments(
	said: string,
	attachments: EntryAttachment[],
	pictured: EntryAttachment[] = [],
): string {
	if (attachments.length === 0) {
		return said;
	}
	let placed = 0;
	const text = said
		.replaceAll(ATTACHMENT_MARK, () => {
			const file = attachments[placed];
			placed += 1;
			return file === undefined ? '' : `[${file.name}]`;
		})
		.trim();
	const lead = `The person attached ${attachments.length === 1 ? 'a file' : `${attachments.length} files`}, kept in their drive. files_read {id, version} on its connection reads one whole, as a sub-agent can; in a sandbox, pap files pull <connection> --id <id> --version <version> brings one in as it is.`;
	return [
		...(text === '' ? [] : [text]),
		lead,
		...attachments.map((attachment) => attachmentLines(attachment, pictured.includes(attachment))),
	].join('\n\n');
}
