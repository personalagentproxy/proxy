import {Result} from 'ts-results-es';
import {z} from 'zod';

/**
 * The built-in agent's log, as the api writes it and the web app reads it: what is shared between
 * them. The log is the transcript: the person's messages, the model's answers with the tool calls
 * it made, what each call answered, events that came since (what a sub-agent said to it), and, once it
 * has grown long, summaries of it up to a point, which the model reads in place of what they
 * cover. A call is pending until its result is in the log, and the model is run again only once
 * none is: starting a sub-agent is answered at once, with its id, and what it says lands as an
 * event when it says it.
 */

/** A tool call the model made, as the model API gives it: its arguments are the JSON it wrote. */
export type ToolCall = {id: string; name: string; arguments: string};

/** A call's arguments as the model wrote them, parsed; null where they aren't JSON. */
export function callArguments(call: ToolCall): unknown {
	const parsed = Result.wrap((): unknown => JSON.parse(call.arguments));
	return parsed.isOk() ? parsed.value : null;
}

/** The text cut to `max` characters, the last of them an ellipsis where it was longer. */
export function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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

/** The names of the agent talking with the person's two tools: a sub-agent, started on a brief, and a message to one. */
export const CREATE_SUBAGENT_TOOL = 'create_subagent';
export const SEND_TO_SUBAGENT_TOOL = 'send_to_subagent';

/** The names of a sub-agent's two tools beyond its connections: a message to the agent it works for, and a wake-up later. */
export const SEND_TO_PARENT_TOOL = 'send_to_parent';
export const SLEEP_TOOL = 'sleep_until';

// How long a sub-agent's title may be: a task's.
const MAX_TITLE = 120;

/** Whether a call's arguments are a JSON object, as a tool takes them. */
export function isRecord(args: unknown): args is Record<string, unknown> {
	return typeof args === 'object' && args !== null && !Array.isArray(args);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/** A create_subagent call's arguments: the sub-agent's title, cut to a task's, and its brief. Null when they are not that. */
export function subAgentArgs(args: unknown): {title: string; brief: string} | null {
	if (!isRecord(args) || !isText(args.title) || !isText(args.brief)) {
		return null;
	}
	return {title: cut(args.title.trim(), MAX_TITLE), brief: args.brief.trim()};
}

/** A send_to_subagent call's arguments: which sub-agent, by id, and the message. Null when they are not that. */
export function subAgentMessageArgs(args: unknown): {subagent: string; text: string} | null {
	if (!isRecord(args) || !isText(args.subagent) || !isText(args.text)) {
		return null;
	}
	return {subagent: args.subagent.trim(), text: args.text.trim()};
}

/** A send_to_parent call's arguments: the message. Null when there is none. */
export function parentMessageArgs(args: unknown): {text: string} | null {
	if (!isRecord(args) || !isText(args.text)) {
		return null;
	}
	return {text: args.text.trim()};
}

// How long a sleep may be at most.
const MAX_SLEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a call to sleep wakes: `{until}` as an ISO time, or `{seconds}` from now; in the past is
 * now, and more than a week is cut to a week. Null when the arguments say neither.
 */
export function sleepUntil(args: unknown, now: Date): Date | null {
	if (!isRecord(args)) {
		return null;
	}
	const {until, seconds} = args;
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
 * What a thread's agent is up to, by the jobs still to run or running on it: at work; asleep,
 * when every one of them is a tool job due later, which only a sleep is, until the first is due;
 * or stopped, with nothing to run, until something lands in its log.
 */
export type ThreadState = {kind: 'working'} | {kind: 'asleep'; until: Date} | {kind: 'stopped'};

export function threadState(
	openJobs: Array<{kind: 'inference' | 'tool'; runAt: Date}>,
	now: Date,
): ThreadState {
	if (openJobs.length === 0) {
		return {kind: 'stopped'};
	}
	const later = openJobs.filter(
		(job) => job.kind === 'tool' && job.runAt.getTime() > now.getTime(),
	);
	if (later.length < openJobs.length) {
		return {kind: 'working'};
	}
	const first = later.map((job) => job.runAt.getTime()).sort((a, b) => a - b)[0];
	return first === undefined ? {kind: 'working'} : {kind: 'asleep', until: new Date(first)};
}

/**
 * A built-in agent's head, as the head lab (design/head-lab) makes it: a sphere in one of eight
 * colors, with painted eyes and a darker nose sphere. A look is what the person keeps beside its
 * name: the shape of its features, in the lab's units; the color is kept beside it. How it is
 * turned is not part of a look: the app poses a head as the moment asks.
 */
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

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export function isAvatarColor(value: string): value is AvatarColor {
	return (AVATAR_COLORS as readonly string[]).includes(value);
}

/** A color as it is kept, one of the eight; blue, the first head's, for one that isn't. */
export function toAvatarColor(value: string): AvatarColor {
	if (isAvatarColor(value)) {
		return value;
	}
	return 'blue';
}

/** A head's features: the nose's size as a share of the head and how far it sits out, the eyes' size and place in degrees, and how many eyes. */
export type Look = {
	nose: number;
	noseOut: number;
	eye: number;
	eyeTheta: number;
	eyeLat: number;
	eyes: 1 | 2;
};

// What the lab's sliders allow of each.
const LOOK_RANGES: Record<Exclude<keyof Look, 'eyes'>, [number, number]> = {
	nose: [0.36, 0.6],
	noseOut: [0.1, 0.7],
	eye: [18, 36],
	eyeTheta: [40, 75],
	eyeLat: [-12, 24],
};

/** The lab's first look (design/head-lab/looks/2026-10-27-blue.json), which a head without one gets. */
export const DEFAULT_LOOK: Look = {
	nose: 0.48,
	noseOut: 0.35,
	eye: 27,
	eyeTheta: 55,
	eyeLat: 8,
	eyes: 2,
};

/** The look as the api takes it and the web app reads it: the lab's units, within what its sliders allow. */
export const lookSchema = z.object({
	nose: z.number().min(LOOK_RANGES.nose[0]).max(LOOK_RANGES.nose[1]),
	noseOut: z.number().min(LOOK_RANGES.noseOut[0]).max(LOOK_RANGES.noseOut[1]),
	eye: z.number().min(LOOK_RANGES.eye[0]).max(LOOK_RANGES.eye[1]),
	eyeTheta: z.number().min(LOOK_RANGES.eyeTheta[0]).max(LOOK_RANGES.eyeTheta[1]),
	eyeLat: z.number().min(LOOK_RANGES.eyeLat[0]).max(LOOK_RANGES.eyeLat[1]),
	eyes: z.union([z.literal(1), z.literal(2)]),
});

/** A look from the JSON it is kept as; the default where there is none, or it isn't one. */
export function parseLook(json: string | null): Look {
	if (json === null) {
		return DEFAULT_LOOK;
	}
	const parsed = Result.wrap((): unknown => JSON.parse(json));
	if (parsed.isErr()) {
		return DEFAULT_LOOK;
	}
	const look = lookSchema.safeParse(parsed.value);
	return look.success ? look.data : DEFAULT_LOOK;
}

// Rounded to what the lab's shuffle gives, so looks read the same in both.
function between(random: () => number, low: number, high: number, decimals: number): number {
	return Number((low + random() * (high - low)).toFixed(decimals));
}

/** A new look, as the lab's shuffle makes one: features within the family's range, two eyes. */
export function shuffleLook(random: () => number = Math.random): Look {
	return {
		nose: between(random, 0.4, 0.58, 3),
		noseOut: between(random, 0.2, 0.6, 2),
		eye: between(random, 22, 34, 1),
		eyeTheta: Math.round(between(random, 45, 70, 0)),
		eyeLat: Math.round(between(random, -8, 20, 0)),
		eyes: 2,
	};
}

// How much of a message a preview of it shows.
const PREVIEW_CHARS = 120;

/** A message as a line of words, for a list: its Markdown marks dropped, its whitespace folded, cut to a line. */
export function preview(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, '')
		.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~|]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, PREVIEW_CHARS);
}
