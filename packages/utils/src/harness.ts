/**
 * The built-in agent's log, as the api writes it and the web app reads it: what is shared between
 * them. The log is the transcript: the person's messages, the model's answers with the tool calls
 * it made, what each call answered, events that came since (a sub-agent's report), and, once it
 * has grown long, summaries of it up to a point, which the model reads in place of what they
 * cover. A call is pending until its result is in the log, and the model is run again only once
 * none is: a delegation is answered at once, that the sub-agent has started, and its report lands
 * as an event when it is done.
 */

/** A tool call the model made, as the model API gives it: its arguments are the JSON it wrote. */
export type ToolCall = {id: string; name: string; arguments: string};

export type LogEntry = {
	kind: 'person' | 'assistant' | 'tool_result' | 'event' | 'summary';
	text: string;
	toolCalls: ToolCall[] | null;
	// A tool_result's or an event's call, by the id the model gave it.
	callId: string | null;
};

/** The calls of the last assistant entry that have no result yet; none when the log is ready for the model. */
export function pendingToolCalls(entries: LogEntry[]): ToolCall[] {
	const last = entries.findLastIndex((entry) => entry.kind === 'assistant');
	if (last === -1) {
		return [];
	}
	const answered = new Set(
		entries
			.slice(last + 1)
			.filter((entry) => entry.kind === 'tool_result')
			.map((entry) => entry.callId),
	);
	return (entries[last]?.toolCalls ?? []).filter((call) => !answered.has(call.id));
}

/**
 * Whether the model should be run on the log: something has come since it last answered, and
 * every call it made has its result.
 */
export function readyForInference(entries: LogEntry[]): boolean {
	if (pendingToolCalls(entries).length > 0) {
		return false;
	}
	const last = entries.at(-1);
	if (!last) {
		return false;
	}
	return last.kind !== 'assistant';
}

/** The name of the one tool the main agent has: a sub-agent, started on a brief, which reports back. */
export const DELEGATE_TOOL = 'delegate';

/** The name of the one tool a sub-agent has beyond its connections: a wake-up later. */
export const SLEEP_TOOL = 'sleep_until';

// How long a sub-agent's title may be: a task's.
const MAX_TITLE = 120;

/** A delegate call's arguments: the sub-agent's title, cut to a task's, and its brief. Null when they are not that. */
export function delegateArgs(args: unknown): {title: string; brief: string} | null {
	if (typeof args !== 'object' || args === null) {
		return null;
	}
	const {title, brief} = args as {title?: unknown; brief?: unknown};
	if (
		typeof title !== 'string' ||
		typeof brief !== 'string' ||
		title.trim() === '' ||
		brief.trim() === ''
	) {
		return null;
	}
	const trimmed = title.trim();
	return {
		title: trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed,
		brief: brief.trim(),
	};
}

// How long a sleep may be at most.
const MAX_SLEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a call to sleep wakes: `{until}` as an ISO time, or `{seconds}` from now; in the past is
 * now, and more than a week is cut to a week. Null when the arguments say neither.
 */
export function sleepUntil(args: unknown, now: Date): Date | null {
	if (typeof args !== 'object' || args === null) {
		return null;
	}
	const {until, seconds} = args as {until?: unknown; seconds?: unknown};
	const requested =
		typeof seconds === 'number'
			? new Date(now.getTime() + seconds * 1000)
			: typeof until === 'string'
				? new Date(until)
				: null;
	if (requested === null || Number.isNaN(requested.getTime())) {
		return null;
	}
	const earliest = Math.max(requested.getTime(), now.getTime());
	return new Date(Math.min(earliest, now.getTime() + MAX_SLEEP_MS));
}

/**
 * A built-in agent's avatar, one of four shapes in one of eight colors, which is all the person
 * picks beside its name, such as Finance or Outreach.
 */
export const AVATAR_SHAPES = ['circle', 'square', 'triangle', 'diamond'] as const;
export const AVATAR_COLORS = [
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export function isAvatarShape(value: string): value is AvatarShape {
	return (AVATAR_SHAPES as readonly string[]).includes(value);
}

export function isAvatarColor(value: string): value is AvatarColor {
	return (AVATAR_COLORS as readonly string[]).includes(value);
}
