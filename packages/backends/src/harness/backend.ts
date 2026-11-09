import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {HarnessSession} from '@proxy/utils/harness';
import type {ContextEntry, SubAgent} from '@proxy/utils/harness-context';

/**
 * What a harness is to the api: the loop that runs one turn of the built-in Chat agent's model on
 * one thread's log, behind a contract this package owns, so that the loop can be swapped. The api
 * keeps everything around a turn: the log, the jobs, the sub-agents, the sleeps, the alerts, the
 * tasks and what the person sees; a harness is given the log as the api has it, with the system
 * prompt and the tools the api built, and tells what the model did as a stream of events. The
 * first harness is the api's own loop over OpenRouter (the api's proxy-harness.ts); a harness
 * around an agent SDK, which keeps a session of its own and runs tools itself, is designed for
 * and comes later. Every harness passes the same tests (conformance.ts); the one the api's tests
 * run on is scripted (fake.ts).
 *
 * The grammar of a turn: zero or more `summary`, `text`, `tool_call` and `tool_result` events,
 * then exactly one `done` or `failed`, which is the last. A `text` is one piece of the answer, in
 * order, never empty. A `tool_call` is a call the model made, its id unique within the turn; a
 * `tool_result` answers a call the same turn made, and comes from a harness that ran the call
 * itself, through the surface's `execute`. A `tool_call` with no `tool_result` by `done` means
 * "run it and call me again": the api runs it as a job of its own and runs the harness once more
 * when every call is answered, which is how a harness whose tools are the api's jobs works; a
 * harness that runs tools inline answers every call before `done`. A `summary` says the harness
 * compacted the log, into a summary standing for every entry up to `coversSeq`, which the api
 * stores for the model to read in place of what it covers. `done` carries the session to keep for
 * the next turn, the system prompt the model was sent, and what the turn cost. `failed` says why,
 * and whether the turn is worth trying again as it is, as when the model couldn't be reached.
 */

/** What a harness keeps per thread between turns, as the api stores it on the thread, opaque to the api (@proxy/utils/harness); null for a harness that keeps nothing. */
export type {HarnessSession};

/** What a call answered; `endTurn` where the call ends the turn, as a sleep does. */
export type ToolAnswer = {text: string; isError: boolean; endTurn?: boolean};

/** A tool as the model is given it: its name, what it does, the JSON Schema of its arguments, and whether it only reads. */
export type HarnessTool = {name: string; description: string; inputSchema: object; readOnly: boolean};

/** The tools of a turn, and how to run one inline; a harness that runs tools as the api's jobs never calls `execute`. */
export type ToolSurface = {
	tools: HarnessTool[];
	execute: (call: {id: string; name: string; arguments: string}) => Promise<Result<ToolAnswer, ApiError>>;
};

export type HarnessEvent =
	| {kind: 'text'; text: string}
	| {kind: 'tool_call'; id: string; name: string; arguments: string}
	| {kind: 'tool_result'; callId: string; text: string; isError: boolean}
	| {kind: 'summary'; text: string; coversSeq: number; inputTokens: number; outputTokens: number}
	| {kind: 'done'; session: HarnessSession; system: string; inputTokens: number; outputTokens: number}
	| {kind: 'failed'; error: ApiError; retry: boolean};

export type HarnessTurn = {
	/** The thread the turn is on; a sub-agent's has the thread it was started from. */
	thread: {id: string; parentThreadId: string | null};
	/** What the harness kept from the thread's last turn, as `done` gave it; null before the first. */
	session: HarnessSession;
	/** The whole log as the api has it; a harness with a session reads what came after it. */
	entries: ContextEntry[];
	/** Who said each event in the log, for the lead-ins: the thread's sub-agents, where it has any. */
	subAgents?: SubAgent[];
	/** Whether the job is a wake-up after a sleep rather than something new in the log. */
	woken: boolean;
	/** The system prompt, built by the api. */
	system: string;
	tools: ToolSurface;
	/** The model to answer with, as the api names it. */
	model: string;
	/** How many steps, calls answered inline and the model asked again, the turn may take at most. */
	maxSteps: number;
	/** Aborted when the turn is to stop: the harness ends it, with `failed` or `done`, as soon as it can. */
	signal: AbortSignal;
};

export type HarnessBackend = {
	/** Which harness it is, kept with each thread's session, so one harness is never given another's. */
	id: string;
	/** One turn of the model on the thread, told as it goes. */
	turn: (input: HarnessTurn) => AsyncIterable<HarnessEvent>;
};
