import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {HarnessSession} from '@proxy/utils/harness';
import type {ContextEntry} from '@proxy/utils/harness-context';

/**
 * What a harness is to the api: the loop that runs one turn of the built-in Chat agent's model on
 * one thread's log, behind a contract this package owns, so that the loop can be swapped. The api
 * keeps everything around a turn: the log, the jobs, the sleeps, the alerts, the tasks and what
 * the person sees; a harness is given the log as the api has it, with the system
 * prompt and the tools the api built, and tells what the model did as a stream of events. The
 * first harness is the api's own loop over OpenRouter (the api's proxy-harness.ts); a harness
 * around an agent SDK, which keeps a session of its own and runs tools itself, is designed for
 * and comes later. Every harness passes the same tests (conformance.ts); the one the api's tests
 * run on is scripted (fake.ts).
 *
 * The grammar of a turn: zero or more `summary`, `text`, `tool_call`, `tool_result` and `usage`
 * events, then exactly one `done` or `failed`, which is the last. A `text` is one piece of the answer, in
 * order, never empty. A `tool_call` is a call the model made, its id unique within the turn; a
 * `tool_result` answers a call the same turn made, and comes from a harness that ran the call
 * itself, through the surface's `execute`. A `tool_call` with no `tool_result` by `done` means
 * "run it and call me again": the api runs it as a job of its own and runs the harness once more
 * when every call is answered, which is how a harness whose tools are the api's jobs works; a
 * harness that runs tools inline answers every call before `done`. A `summary` says the harness
 * compacted the log, into a summary standing for every entry up to `coversSeq`, which the api
 * stores for the model to read in place of what it covers. `done` carries the session to keep for
 * the next turn, the system prompt the model was sent, and what the turn cost. `failed` says why,
 * and whether the turn is worth trying again as it is, as when the model couldn't be reached; a
 * failure of kind `credentials_rejected` says the credential the turn was given (`auth`) was
 * turned down, which the api answers by noting it on the member's account and telling them to
 * connect again, and one with `limitReached` that the provider takes no more from the member's
 * account for now, their plan's limit reached, which the api tells them, with when it resets where
 * the provider said, rather than trying again. A `usage` is what the model's provider said of the member's plan as the turn
 * ran: how much of the five-hour or the seven-day window is used, as a share from 0 to 1, and when
 * it resets; zero or more per turn, any time before the terminal event, and a harness on the
 * server's key yields none.
 *
 * A harness says, beside its id, what it is called to the person choosing one for an agent, its
 * `label`, and the `models` it can answer with, the first the one a turn gets where none of them
 * was chosen; and `maxConcurrentTurns`, how many turns it can run at once in one process, where
 * each is a subprocess with memory of its own.
 */

/** What a harness keeps per thread between turns, as the api stores it on the thread, opaque to the api (@proxy/utils/harness); null for a harness that keeps nothing. */
export type {HarnessSession};

/** An entry of the log as a harness is given it: as the model reads it, what the person said with the pictures they attached to it where the model sees pictures, with the job that wrote it, a turn's for what the model said and what its calls answered; null for what the person wrote. */
export type HarnessEntry = ContextEntry & {jobId: string | null};

/**
 * A model a harness can answer with: the id a persona keeps it under, what the person picking one
 * reads, and whether it sees pictures: a turn on one that does is given the pictures the person
 * attached with what they said (`HarnessEntry.images`), and a turn on one that doesn't never is.
 */
export type HarnessModel = {id: string; label: string; images?: true};

/** What a call answered; `endTurn` where the call ends the turn, as a sleep does. */
export type ToolAnswer = {text: string; isError: boolean; endTurn?: boolean};

/** A tool as the model is given it: its name, what it does, the JSON Schema of its arguments, and whether it only reads. */
export type HarnessTool = {name: string; description: string; inputSchema: object; readOnly: boolean};

/** The tools of a turn, and how to run one inline; a harness that runs tools as the api's jobs never calls `execute`. */
export type ToolSurface = {
	tools: HarnessTool[];
	execute: (call: {id: string; name: string; arguments: string}) => Promise<Result<ToolAnswer, ApiError>>;
};

/** How much of one of the member's plan's windows is used, 0 to 1, and when it resets, where the provider said. */
export type UsageWindow = {utilization: number; resetsAt: Date | null};

export type HarnessEvent =
	| {kind: 'text'; text: string}
	| {kind: 'tool_call'; id: string; name: string; arguments: string}
	| {kind: 'tool_result'; callId: string; text: string; isError: boolean}
	| {kind: 'summary'; text: string; coversSeq: number; inputTokens: number; outputTokens: number}
	| {kind: 'usage'; fiveHour?: UsageWindow; sevenDay?: UsageWindow}
	| {kind: 'done'; session: HarnessSession; system: string; inputTokens: number; outputTokens: number}
	| {kind: 'failed'; error: ApiError; retry: boolean; limitReached?: {resetsAt: Date | null}};

/**
 * The credential a turn runs under where the model is reached as the member rather than with the
 * server's key: a long-lived Claude token, handed over as a sign-in's access token with no scopes,
 * or an API key. A harness that reaches the model with the server's key,
 * as the proxy harness does over OpenRouter, ignores it.
 */
export type HarnessAuth = {kind: 'oauth'; accessToken: string; scopes: string[]} | {kind: 'api_key'; key: string};

export type HarnessTurn = {
	/** The thread the turn is on. */
	thread: {id: string};
	/** The job the turn is run for, the same on every attempt at it: what the log has from it already is an earlier attempt's, cut short. */
	job: string;
	/** The member's credential to reach the model with, where the harness is chosen for one; none where the harness runs with the server's key. */
	auth?: HarnessAuth;
	/** What the harness kept from the thread's last turn, as `done` gave it; null before the first, and where the thread's last turn was another harness's. */
	session: HarnessSession;
	/** The whole log as the api has it; a harness with a session reads what came after it. */
	entries: HarnessEntry[];
	/** Whether the job is a wake-up after a sleep rather than something new in the log. */
	woken: boolean;
	/** The system prompt, built by the api. */
	system: string;
	tools: ToolSurface;
	/** The model to answer with: one of the harness's `models`, by its id. */
	model: string;
	/** Aborted when the turn is to stop: the harness ends it, with `failed` or `done`, as soon as it can. */
	signal: AbortSignal;
};

export type HarnessBackend = {
	/** Which harness it is, kept with each thread's session, so one harness is never given another's, and with each persona that chose it. */
	id: string;
	/** What the person choosing a harness for an agent reads it as. */
	label: string;
	/** The models it can answer with, the first its default: at least one. */
	models: [HarnessModel, ...HarnessModel[]];
	/** How many turns of this harness one process runs at once at most; unset for a harness that is only a request to a model, which needs no cap. */
	maxConcurrentTurns?: number;
	/** One turn of the model on the thread, told as it goes. */
	turn: (input: HarnessTurn) => AsyncIterable<HarnessEvent>;
};
