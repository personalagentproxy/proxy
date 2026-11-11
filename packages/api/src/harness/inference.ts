import {Err, type Result} from 'ts-results-es';

import type {HarnessBackend, HarnessEvent} from '@proxy/backends/harness/backend';
import {ApiErr, type ApiError, Do, requirePresent, semaphore, type Semaphore} from '@proxy/utils';
import {CALL_INTERRUPTED, type HarnessSession, OUTCOME_UNKNOWN, pendingToolCalls, type ToolCall} from '@proxy/utils/harness';
import type {EntryAttachment} from '@proxy/utils/harness-context';
import type {SignedInAgent} from '@proxy/db/agent';
import type {AssistantTurn, EntryRow, JobRow, NewTurnEntry, RanOn, SubAgentRow, ThreadRow, ThreadSession} from '@proxy/db/harness';

import {chosenFor, type ClaudeCredentials, type HarnessChoice, type Harnesses, harnessFor, needsCredential} from '../backends/harness';
import {agentInstructions, SCRIPT_TOOL} from '../mcp/tools';
import {SIGN_IN_EXPIRED} from '../me/claude-token';
import {log, serializeError} from '../observability/log';
import {alertsParagraph} from './alerts';
import {picturesOf, withAttached} from './attachments';
import {afterAnswer, failureNote, jobLost, planCalls} from './conversation';
import type {HarnessStore} from './store';
import {type ToolSurfaceStore, toolSurfaceFor} from './tool-surface';

/**
 * An inference job: the model, run once on a thread's log, which is ready for it, every call
 * answered, and changes under it only by what the job itself writes (db/harness). The model's
 * turn is the harness's (@proxy/backends/harness), chosen for the thread among those the server
 * has (backends/harness.ts): this builds the system prompt and the tools, gives the harness the
 * log, and takes back what the model did as events, writing the log as they come. A summary is
 * written as the harness compacts the log. A harness that runs its tools itself answers each call
 * with a `tool_result`: what the model said at the step, with its calls, goes in the log as an
 * assistant entry then, the result after it, so the log reads in order and a worker that dies
 * mid-turn leaves what was done; the first such entry carries the system prompt. What is left as
 * the turn is done, the model's last words and the calls it left open, goes in with the job's
 * end, each open call planned (conversation.ts planCall): a tool job, due now or, for a sleep,
 * when the sleep ends; or an answer at once, which is what starting a sub-agent gets, with its id,
 * a message to one, with what it was up to, a message to the agent a sub-agent works for, and a
 * call with arguments that are no good. A harness that keeps a session between turns leaves it on
 * the thread then, with its id, and is given it back only while the thread's turns are its: a
 * thread that moved to another harness, its persona switched to it, starts there without one, on
 * the log. A turn that failed and is worth trying again, the model out of reach,
 * is tried again a few times, then the person is told; a credential the model turned down is noted
 * on the member's account, for the Account page to say so, and the person is told to connect
 * again; a member's account at its plan's limit is told them, with when it resets, and not tried
 * again; any other failure fails the job, which tells them too (conversation.ts failureNote). A
 * turn runs for minutes on a harness that takes many steps, so what is timed within it, a sleep,
 * an alert, a retry, is timed by the clock as it is then, not as the job began. What the model's provider says of the member's plan as a turn
 * on their credential runs is kept on their account too, for the card, as best it can be: a
 * failure to keep it is logged, and the turn goes on. A sub-agent's answer with no calls goes to the agent it works for, and stops its
 * work for now, unless a message came while it answered. An answer of nothing, no words and no
 * calls, is written as that said: the person would otherwise see nothing, and the model refuses a
 * log with an empty turn in it. The harness and the model are the thread's persona's, read at each
 * turn, a sub-agent's the persona's it works as (backends/harness.ts), and each answer is written
 * with the two it ran on. An answer of the agent talking with the person is written with the files it shows them,
 * pictures among its words that link to files the agent may read, each at the version it holds
 * then (native/files/chat.ts), as best they can be read: one that can't is left a link, and the
 * answer is written all the same. The answer is written with the system prompt the model was sent, which is built
 * from the login's grants as they are then and, for the agent talking with the person, its
 * sub-agents as they are then, so that what the model read can be told later; the rest of the
 * request is rebuilt from the log. The agent talking with the person is told the alerts set in the
 * conversation too, by id, so it can cancel one. A wake job, the wake-up after a sleep the harness
 * answered itself, is run the same way, the harness told it was woken. Without a harness for the
 * thread, as a server without an OpenRouter key has none, the person is told so.
 *
 * A turn tried again, the worker that ran it before having died, may find the log's last answer
 * with calls still open: a harness that runs its tools itself wrote the step and died before the
 * result. Each is closed first, with a result saying so, a script's that its outcome is unknown,
 * and the harness runs on the log so closed. A thread on a harness that leaves its calls open
 * never has any here: its inference job is queued only once every call is answered, and it
 * writes its answer only as the job ends, so a job of its that is tried again finds the log as
 * the first attempt did.
 */

/** What an inference job needs of the store: the thread and its log, the writes of a turn, and what running a call inline needs. */
export type InferenceStore = Pick<
	HarnessStore,
	| 'getJobThread'
	| 'getThreadAgent'
	| 'getPersonaModel'
	| 'listEntries'
	| 'listAttachments'
	| 'listSubAgents'
	| 'listThreadAlerts'
	| 'finishJob'
	| 'failJob'
	| 'requeueJob'
	| 'appendSummary'
	| 'appendTurnEntries'
	| 'completeInference'
> &
	ToolSurfaceStore;

// How the agent talking with the person is to go about it: it does nothing itself, and hands
// every piece of work to a sub-agent, which it can go on talking with, and which the person can
// open as a task, read and write to themselves.
const MAIN_FLOW =
	'You are chatting with the person on Personal Agent Proxy’s Chat page. Answer in short Markdown: sentences, a list or table where clearer, no headings. To show the person a picture, such as a chart or a screenshot, have it put in a drive and write it as a Markdown image of its Link: ![what it shows](Link); a picture anywhere else is shown as a link only. You can’t reach their accounts yourself: sub-agents do it for you, so the pap calls these instructions name go in a sub-agent’s brief. Give one question to one sub-agent, even across accounts; start several only for separate, sizeable jobs. A stopped sub-agent keeps what it found: message it for follow-ups rather than starting another. While sub-agents work, tell the person in a few words what you are looking into, and stop. Never mention sub-agents, briefs or messages: to the person, you do the work. When a sub-agent’s message needs no word to the person yet, as while others are still at work, answer with nothing. The person sees each sub-agent as a task they can open, read and write to: what they wrote to one comes to you as a note, and its answer as its messages do; they saw that answer, so don’t repeat it, and answer with nothing unless there is something to add. For something at a time, or something new in their accounts, set an alert rather than a sub-agent. Don’t mention summaries of the conversation.';

// How a sub-agent is to go about it: a brief, its tools, messages to and from the agent it works
// for, and an answer when it stops.
const SUB_FLOW =
	'You are a sub-agent of the Chat agent of Personal Agent Proxy. Your brief and later messages come from that agent, except those marked as the person’s own: the person can open your chat, see what you answer and the agent’s messages, and write to you there. Work in scripts; check pap.tools before using a tool you haven’t used. Your task is kept for you. To ask something you can’t go on without, answer with the question and no tool call. Your first answer without a tool call is handed to the agent and stops you: say what you did and found, with the names, ids, dates and numbers that matter, and what you couldn’t do. A later message takes you up again with this log.';

// How many answers the model may give in a row without the person saying anything, calls,
// sub-agents' messages and wake-ups included, before it stops and waits for them; a message that
// comes after the stop is acted on, and the count starts over. For a sub-agent, the person is the
// agent it works for, whose messages are what it hears.
const MAX_TURNS_ALONE = 30;

// How often a model that can't be reached is tried, and how long to wait between tries.
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_MS = 5_000;

// How many steps a turn may take on a harness that asks the model once and leaves its calls open
// for the worker to run: one; how many answers the model may give in a row is MAX_TURNS_ALONE,
// counted over the log, where one turn is one answer. A harness that answers its calls itself and
// asks the model again within the turn gets as many steps as the thread has left.
const ONE_STEP = 1;

const UNREACHABLE = 'The model could not be reached. Say something to try again.';

// What the person is told where the model's provider takes no more from their account for now:
// that the limit is reached, and when it resets, where the provider said.
function limitReached(resetsAt: Date | null): string {
	const resets = resetsAt === null ? '' : `, which resets at ${resetsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	return `Your Claude account has reached its limit for now${resets}. Say something to try again after that.`;
}
const TOO_LONG = `I have taken ${MAX_TURNS_ALONE} steps without hearing from you, so I have stopped. Tell me to go on if you want me to.`;
const TOO_LONG_SUB = `I took ${MAX_TURNS_ALONE} steps without hearing from you, so I stopped. This is not a complete answer: tell me to go on if you want me to.`;
const NOTHING = 'I had nothing to say to that. Say something to go on.';
const NOTHING_SUB = 'I stopped without saying anything.';

// Whether the answer is the model stopping for the person, at the cap: the count starts over
// from it, so a sub-agent's message that comes after the stop is acted on rather than answered
// with the stop again, once per message.
function isStop(entry: EntryRow): boolean {
	return entry.kind === 'assistant' && (entry.text === TOO_LONG || entry.text === TOO_LONG_SUB);
}

// How many answers the model has given since the person last spoke, or since it last stopped for
// them.
function turnsAlone(entries: EntryRow[]): number {
	const since = entries.findLastIndex((entry) => entry.kind === 'person' || isStop(entry));
	return entries.slice(since + 1).filter((entry) => entry.kind === 'assistant').length;
}

// What the turn came to: what the model said last, the files it showed there and the calls it made then, those it left open
// among all it made, whether the turn wrote to the log as it went, what it cost, the system prompt
// sent and the session the harness kept; or a failure, with whether the turn is worth trying again
// as it is, and, where it is the member's account at its limit, when that resets.
type TurnOutcome =
	| {
			kind: 'done';
			text: string;
			attachments: EntryAttachment[];
			toolCalls: ToolCall[];
			open: ToolCall[];
			wroteInline: boolean;
			inputTokens: number;
			outputTokens: number;
			system: string;
			session: HarnessSession;
	  }
	| {kind: 'failed'; error: ApiError; retry: boolean; limitReached?: {resetsAt: Date | null}};

// The answer as it goes in the log: an answer of nothing says so, but for the agent talking with
// the person woken by a sub-agent's message or an alert rather than by them, which may let it pass
// in silence; the page shows no answer without words, and the model doesn't read it again.
function said(thread: ThreadRow, entries: EntryRow[], turn: {text: string; toolCalls: ToolCall[]}): string {
	if (turn.text.trim() !== '' || turn.toolCalls.length > 0) {
		return turn.text;
	}
	if (thread.parentThreadId !== null) {
		return NOTHING_SUB;
	}
	if (entries.findLast((entry) => entry.kind === 'person' || entry.kind === 'event')?.kind === 'event') {
		return '';
	}
	return NOTHING;
}

// Answers the person with `text` alone, as the model would, when the model can't be run: no
// prompt was built. A job no longer the worker's is a conflict.
function answerWith(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, text: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const turn: AssistantTurn = {text, toolCalls: [], inputTokens: 0, outputTokens: 0, system: null};
		if (!$(await store.completeInference(job.id, workerId, job.threadId, turn, afterAnswer(thread, turn, {})))) {
			return $(Err(jobLost()));
		}
	});
}

// Tells of a turn that can't be run, with `why`: the person is answered with it; a sub-agent's
// job fails with it, and the sub-agent stops with it as an error, as a turn that failed does
// (conversation.ts failureNote), so the agent it works for isn't left waiting.
function answerFailure(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, why: string): Promise<Result<void, ApiError>> {
	if (thread.parentThreadId === null) {
		return answerWith(store, job, workerId, thread, why);
	}
	return Do(async ($) => {
		if (!$(await store.failJob(job.id, workerId, why, failureNote(why)))) {
			return $(Err(jobLost()));
		}
	});
}

// A sub-agent as the roster has it: its id, its title, and what it is up to.
function rosterLine(subAgent: SubAgentRow): string {
	const doing = subAgent.state.kind === 'working' ? 'at work' : subAgent.state.kind === 'asleep' ? `asleep until ${subAgent.state.until.toISOString()}` : 'stopped';
	return `- ${subAgent.id}: “${subAgent.title ?? ''}”, ${doing}`;
}

// How many of the sub-agents that have stopped the roster lists, the latest: a long conversation
// starts more than its prompt should carry, and those at work or asleep are listed whatever their
// number.
const MAX_STOPPED_LISTED = 10;

// The main agent's sub-agents, for its system prompt: what it has started, by id, and what each
// is doing now, which a summary of the conversation might have lost; of those that have stopped,
// the latest, with how many older ones there are.
function roster(subAgents: SubAgentRow[]): string {
	if (subAgents.length === 0) {
		return 'No sub-agents yet.';
	}
	const stopped = subAgents.filter((subAgent) => subAgent.state.kind === 'stopped');
	const unlisted = new Set(stopped.slice(0, -MAX_STOPPED_LISTED).map((subAgent) => subAgent.id));
	const listed = subAgents.filter((subAgent) => !unlisted.has(subAgent.id)).map(rosterLine);
	const older = unlisted.size === 0 ? [] : [`- ${unlisted.size} older stopped ones, not listed`];
	return `Sub-agents:\n${[...older, ...listed].join('\n')}`;
}

// Why the model couldn't be reached, for the job's record.
function unreachable(failure: ApiError): string {
	const cause = 'cause' in failure ? failure.cause : null;
	return `The model could not be reached${cause instanceof Error ? `: ${cause.message}` : ''}`;
}

// The system prompt: the instructions any agent with the login gets, for the agent as it acts in
// the thread, as the member whose conversation it is, how to go about it on this thread, and, for
// the agent talking with the person, its sub-agents and the alerts set in the conversation.
function systemPrompt(store: InferenceStore, thread: ThreadRow, signedIn: SignedInAgent, subAgents: SubAgentRow[], now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const instructions = $(await agentInstructions(signedIn, thread.parentThreadId === null ? MAIN_FLOW : SUB_FLOW));
		const about = thread.parentThreadId === null ? [roster(subAgents), alertsParagraph($(await store.listThreadAlerts(thread.id)))] : [];
		return [instructions, ...about, `The time now is ${now.toISOString()}.`].join('\n\n');
	});
}

/** What a turn's `usage` event is given to: what the provider said of the member's plan. */
type UsageSink = (usage: Extract<HarnessEvent, {kind: 'usage'}>) => Promise<void>;

/** The files an answer shows the person, as best they can be read: none where they can't. */
type Pin = (text: string) => Promise<EntryAttachment[]>;

const PINS_NOTHING: Pin = async () => [];

// The files the answers of the agent talking with the person show them, read as the agent acts for
// them; a sub-agent's answers are for the agent it works for, and show the person nothing. What
// can't be read is logged, and the answer goes without them: the model has answered, and a turn
// run again for a picture would answer anew.
function pinFor(harnesses: Harnesses, thread: ThreadRow, signedIn: SignedInAgent): Pin {
	const {pinned} = harnesses;
	if (pinned === undefined || thread.parentThreadId !== null) {
		return PINS_NOTHING;
	}
	return async (text) => {
		const read = await pinned(signedIn, text);
		if (read.isErr()) {
			log.warn('The files an answer shows could not be kept with it, and are left links', {threadId: thread.id, ...serializeError('cause' in read.error ? read.error.cause : read.error)});
			return [];
		}
		return read.value;
	};
}

// What the harness did, from its events, written as it goes, every write fenced by the lease: a
// summary as it comes; the answer's words, each piece after the last, and its calls kept as the
// step under way, which a result the harness answered a call with ends, the step written as an
// assistant entry, with the harness and the model it ran on and the files its words show (`pin`),
// and the result after it, the first step with the system prompt; what is left
// when `done` comes is the turn's last step, given back with what the turn cost, the session kept
// and the calls still open. What the provider said of the plan goes to `onUsage`. A result for a
// call the turn didn't make, or answered already, and a turn that ends without `done` or `failed`,
// are failures of the harness.
function consume(
	store: InferenceStore,
	job: JobRow,
	workerId: string,
	sent: {system: string; ranOn: RanOn},
	events: AsyncIterable<HarnessEvent>,
	onUsage: UsageSink,
	pin: Pin,
): Promise<Result<TurnOutcome, ApiError>> {
	return Do(async ($) => {
		let pieces: string[] = [];
		let toolCalls: ToolCall[] = [];
		const open = new Map<string, ToolCall>();
		let wroteInline = false;
		for await (const event of events) {
			if (event.kind === 'usage') {
				await onUsage(event);
				continue;
			}
			if (event.kind === 'summary') {
				const written = $(await store.appendSummary(job.id, workerId, job.threadId, {text: event.text, inputTokens: event.inputTokens, outputTokens: event.outputTokens}, event.coversSeq));
				if (!written) {
					return $(Err(jobLost()));
				}
				continue;
			}
			if (event.kind === 'text') {
				pieces.push(event.text);
				continue;
			}
			if (event.kind === 'tool_call') {
				const call = {id: event.id, name: event.name, arguments: event.arguments};
				toolCalls.push(call);
				open.set(call.id, call);
				continue;
			}
			if (event.kind === 'tool_result') {
				if (!open.delete(event.callId)) {
					return $(Err(ApiErr.internalError(new Error(`The harness answered the call ${event.callId}, which the turn did not make, or answered already`))));
				}
				const text = pieces.join('\n\n');
				const attachments = await pin(text);
				const step: NewTurnEntry[] =
					pieces.length === 0 && toolCalls.length === 0
						? []
						: [{kind: 'assistant', text, toolCalls, ranOn: sent.ranOn, ...(wroteInline ? {} : {system: sent.system}), ...(attachments.length === 0 ? {} : {attachments})}];
				const result: NewTurnEntry = {kind: 'tool_result', callId: event.callId, text: event.text, isError: event.isError};
				if (!$(await store.appendTurnEntries(job.id, workerId, job.threadId, [...step, result]))) {
					return $(Err(jobLost()));
				}
				wroteInline = true;
				pieces = [];
				toolCalls = [];
				continue;
			}
			if (event.kind === 'failed') {
				return {kind: 'failed', error: event.error, retry: event.retry, ...(event.limitReached ? {limitReached: event.limitReached} : {})};
			}
			const text = pieces.join('\n\n');
			return {
				kind: 'done',
				text,
				attachments: await pin(text),
				toolCalls,
				open: [...open.values()],
				wroteInline,
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				system: event.system,
				session: event.session,
			};
		}
		return $(Err(ApiErr.internalError(new Error('The harness ended the turn without saying how'))));
	});
}

// The cap on the turns of each harness under way in this process, where the harness has one,
// made as the harness is first run.
const limits = new WeakMap<HarnessBackend, Semaphore>();

// Runs `work`, a turn of the harness, within the harness's cap on turns at once, where it has one.
// The worker claims no more turns for a capped harness than its cap (worker.ts), so a turn seldom
// waits here, holding a job the worker has room for nothing else in the meantime: only one whose
// member connected their account between the claim and the turn. The cap holds either way.
function limited<T>(harness: HarnessBackend, work: () => Promise<T>): Promise<T> {
	if (harness.maxConcurrentTurns === undefined) {
		return work();
	}
	const limit = limits.get(harness) ?? semaphore(harness.maxConcurrentTurns);
	limits.set(harness, limit);
	return limit.run(work);
}

// How many steps the turn may take: one on a harness that leaves its calls open; on one that
// answers them itself, as many as the thread has left before the model has to stop for the person.
function maxSteps(harness: HarnessBackend, entries: EntryRow[]): number {
	if (harness.stepsPerTurn === 'many') {
		return MAX_TURNS_ALONE - turnsAlone(entries);
	}
	return ONE_STEP;
}

// Where what the provider said of the member's plan goes: their account, where the turn runs on
// their credential, as best it can be kept; nowhere on the server's key, which has no plan of
// theirs to speak of.
function usageSink(credentials: ClaudeCredentials, choice: HarnessChoice, thread: ThreadRow, clock: () => Date): UsageSink {
	if (choice.auth === null) {
		return async () => {};
	}
	return async (usage) => {
		const kept = await credentials.recordUsage(thread.userId, {...(usage.fiveHour ? {fiveHour: usage.fiveHour} : {}), ...(usage.sevenDay ? {sevenDay: usage.sevenDay} : {}), readAt: clock()});
		if (kept.isErr()) {
			log.warn('What the model’s provider said of the member’s plan could not be kept', {userId: thread.userId, ...serializeError(kept.error)});
		}
	};
}

// The harness's turn on the log, with the system prompt built for it as the turn starts, within
// the harness's cap, and the credential the harness was chosen with, if any. The session is the
// thread's where the harness is the one that kept it, and none where the thread's last turn was
// another's. The thread's sub-agents are read once, for the prompt and for whose each message in
// the log is; a sub-agent's thread has none. The signal is never aborted: stopping the worker lets
// the turns under way finish, as it always has.
function askOnLog(
	store: InferenceStore,
	harnesses: Harnesses,
	choice: HarnessChoice & {harness: HarnessBackend},
	job: JobRow,
	workerId: string,
	thread: ThreadRow,
	entries: EntryRow[],
	woken: boolean,
	clock: () => Date,
): Promise<Result<TurnOutcome, ApiError>> {
	return limited(choice.harness, () =>
		Do(async ($) => {
			const {credentials, picture} = harnesses;
			const now = clock();
			const subAgents = thread.parentThreadId === null ? $(await store.listSubAgents(thread.id, now)) : [];
			const signedIn = $(requirePresent($(await store.getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
			const system = $(await systemPrompt(store, thread, signedIn, subAgents, now));
			// What the person attached is read with what they said: in the conversation, and in a
			// sub-agent's thread what they wrote in its chat, its brief being the agent's own words.
			const attached = $(await store.listAttachments(thread.id));
			// A model that sees pictures is given those of the person's last turns beside their words.
			const sees = choice.harness.models.some((model) => model.id === choice.model && model.images === true);
			const pictures = picture !== undefined && sees && attached.length > 0 ? $(await picturesOf(entries, attached, picture)) : [];
			return $(
				await consume(
					store,
					job,
					workerId,
					{system, ranOn: {harness: choice.harness.id, model: choice.model}},
					choice.harness.turn({
						thread: {id: thread.id, parentThreadId: thread.parentThreadId},
						job: job.id,
						...(choice.auth === null ? {} : {auth: choice.auth}),
						session: thread.harness === choice.harness.id ? thread.harnessSession : null,
						entries: withAttached(entries, attached, pictures),
						subAgents,
						woken,
						system,
						tools: toolSurfaceFor(store, thread, job, workerId, clock),
						model: choice.model,
						maxSteps: maxSteps(choice.harness, entries),
						signal: new AbortController().signal,
					}),
					usageSink(credentials, choice, thread, clock),
					pinFor(harnesses, thread, signedIn),
				),
			);
		}),
	);
}

// Writes what the turn ended with: its last step, said, and what follows it, each open call as
// planned; a sub-agent's last step without calls stops it. A turn that wrote to the log as it
// went and has nothing left, as one ends that answered a sleep, writes no entry more. The session
// goes on the thread where the harness kept one, or the thread records a harness already, whose
// session is then no longer the thread's, so a harness that keeps nothing writes nothing on a
// thread that has nothing there.
function writeBack(
	store: InferenceStore,
	job: JobRow,
	workerId: string,
	thread: ThreadRow,
	entries: EntryRow[],
	choice: HarnessChoice & {harness: HarnessBackend},
	outcome: Extract<TurnOutcome, {kind: 'done'}>,
	now: Date,
): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {harness} = choice;
		const session: ThreadSession | undefined = outcome.session !== null || thread.harness !== null ? {harness: harness.id, session: outcome.session} : undefined;
		const plans = planCalls(thread, outcome.open, now);
		const nothingLeft = outcome.wroteInline && outcome.text.trim() === '' && outcome.toolCalls.length === 0;
		const turn: AssistantTurn | null = nothingLeft
			? null
			: {
					text: said(thread, entries, outcome),
					...(outcome.attachments.length === 0 ? {} : {attachments: outcome.attachments}),
					toolCalls: outcome.toolCalls,
					inputTokens: outcome.inputTokens,
					outputTokens: outcome.outputTokens,
					system: outcome.system,
					ranOn: {harness: harness.id, model: choice.model},
				};
		const after = turn === null ? {plans} : afterAnswer(thread, turn, plans);
		if (!$(await store.completeInference(job.id, workerId, job.threadId, turn, after, ...(session === undefined ? [] : [session])))) {
			return $(Err(jobLost()));
		}
	});
}

// Closes the calls the log's last answer left open, from a previous attempt of the job that died
// before answering them: each with a result saying so, a script's that its outcome is unknown.
function closeOpenCalls(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, open: ToolCall[]): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const results: NewTurnEntry[] = open.map((call) => ({kind: 'tool_result', callId: call.id, text: call.name === SCRIPT_TOOL ? OUTCOME_UNKNOWN : CALL_INTERRUPTED, isError: true}));
		if (!$(await store.appendTurnEntries(job.id, workerId, thread.id, results))) {
			return $(Err(jobLost()));
		}
	});
}

// The log, ready for the model: as it is, or, where the last answer's calls are open, with each
// closed (module comment) and read again.
function readyLog(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow): Promise<Result<EntryRow[], ApiError>> {
	return Do(async ($) => {
		const entries = $(await store.listEntries(thread.id));
		const open = pendingToolCalls(entries);
		if (open.length === 0) {
			return entries;
		}
		log.warn('A turn tried again found calls left open, and closed them', {jobId: job.id, attempt: job.attempts, calls: open.map((call) => call.name)});
		$(await closeOpenCalls(store, job, workerId, thread, open));
		return $(await store.listEntries(thread.id));
	});
}

// What a thread's persona runs on where it is gone, the thread about to go with it: the database's
// defaults for a persona.
const NO_PERSONA = {harness: 'proxy', chatModel: 'claude'};

// The harness for a turn on the thread, and the model: its persona's choice as the server has it,
// with the member's credential where the harness runs on it (backends/harness.ts). A credential
// that ran out or was refused is what the person is told; one that couldn't be read for another
// reason fails the turn with it.
function chooseHarness(store: InferenceStore, harnesses: Harnesses, thread: ThreadRow): Promise<Result<HarnessChoice, ApiError>> {
	return Do(async ($) => {
		const persona = $(await store.getPersonaModel(thread)) ?? NO_PERSONA;
		const chosen = chosenFor(harnesses.registry, persona);
		if (chosen === null || !needsCredential(harnesses.registry, chosen.harness)) {
			return harnessFor(harnesses.registry, persona, null);
		}
		const credential = await harnesses.credentials.claudeCredentialFor(thread.userId);
		if (credential.isErr() && credential.error.kind === 'unavailable') {
			return {harness: null, auth: null, why: credential.error.message};
		}
		return harnessFor(harnesses.registry, persona, $(credential));
	});
}

// Whether the failure is the model turning down the credential the turn was given.
function credentialRefused(outcome: TurnOutcome, choice: HarnessChoice): boolean {
	return outcome.kind === 'failed' && outcome.error.kind === 'credentials_rejected' && choice.auth !== null;
}

/** Runs the job: one turn of the harness chosen for its thread on the thread's log, written as it goes, the harness told where the job is a wake-up after a sleep (`woken`); nothing when the thread is gone. `clock` tells the time as the turn goes. */
export function runInference(store: InferenceStore, harnesses: Harnesses, job: JobRow, workerId: string, woken = false, clock: () => Date = () => new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await store.getJobThread(job.threadId));
		if (!thread) {
			$(await store.finishJob(job.id, workerId));
			return;
		}
		const entries = $(await readyLog(store, job, workerId, thread));
		if (turnsAlone(entries) >= MAX_TURNS_ALONE) {
			$(await answerWith(store, job, workerId, thread, thread.parentThreadId === null ? TOO_LONG : TOO_LONG_SUB));
			return;
		}
		const choice = $(await chooseHarness(store, harnesses, thread));
		if (choice.harness === null) {
			$(await answerFailure(store, job, workerId, thread, choice.why));
			return;
		}
		const outcome = $(await askOnLog(store, harnesses, choice, job, workerId, thread, entries, woken, clock));
		if (credentialRefused(outcome, choice)) {
			// Noted on the account as best it can be: the person is told either way.
			const marked = await harnesses.credentials.markRefused(thread.userId);
			if (marked.isErr()) {
				log.warn('The model turned the member’s Claude credential down, which could not be noted on their account', {userId: thread.userId, ...serializeError(marked.error)});
			}
			$(await answerFailure(store, job, workerId, thread, SIGN_IN_EXPIRED));
			return;
		}
		if (outcome.kind === 'failed' && outcome.limitReached) {
			log.warn('The model’s provider takes no more from the member’s account for now', {userId: thread.userId, resetsAt: outcome.limitReached.resetsAt?.toISOString() ?? null});
			$(await answerFailure(store, job, workerId, thread, limitReached(outcome.limitReached.resetsAt)));
			return;
		}
		if (outcome.kind === 'failed' && !outcome.retry) {
			return $(Err(outcome.error));
		}
		if (outcome.kind === 'failed') {
			log.warn('The built-in agent’s model could not be reached', {attempt: job.attempts, ...serializeError('cause' in outcome.error ? outcome.error.cause : outcome.error)});
			if (job.attempts < MAX_MODEL_ATTEMPTS) {
				$(await store.requeueJob(job.id, workerId, thread.id, new Date(clock().getTime() + RETRY_MS * job.attempts), unreachable(outcome.error)));
				return;
			}
			$(await answerWith(store, job, workerId, thread, UNREACHABLE));
			return;
		}
		$(await writeBack(store, job, workerId, thread, entries, choice, outcome, clock()));
	});
}
