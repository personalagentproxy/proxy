/**
 * The built-in agent's log, as the api writes it and the web app reads it: what is shared between
 * them. The log is the transcript: the person's messages, the model's answers with the tool calls
 * it made, and what each call answered. A call is pending until its result is in the log, and the
 * model is run again only once none is.
 */

/** A tool call the model made, as the model API gives it: its arguments are the JSON it wrote. */
export type ToolCall = {id: string; name: string; arguments: string};

export type LogEntry = {
	kind: 'person' | 'assistant' | 'tool_result';
	text: string;
	toolCalls: ToolCall[] | null;
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

/** The name of the one tool the built-in agent has beyond its connections: a wake-up later. */
export const SLEEP_TOOL = 'sleep_until';

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
