import {randomUUID} from 'node:crypto';
import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {type CanUseTool, type Options, query as sdkQuery, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage, type SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {ContentBlockParam, MessageParam, ToolResultBlockParam} from '@anthropic-ai/sdk/resources';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';
import {type ContextEntry, type EntryImage, eventLead, type SubAgent, toTranscript} from '@proxy/utils/harness-context';

import type {HarnessAuth, HarnessBackend, HarnessEntry, HarnessEvent, HarnessTurn, ToolAnswer, ToolSurface} from './backend';
import type {SdkSessionStore} from './session-store';

/**
 * The harness on the Claude Agent SDK: a turn is one `query()` of the SDK, which spawns Claude
 * Code's own binary as a subprocess and talks to it over stdio, run as the member, on the Claude
 * credential they connected. The SDK keeps a session per thread, its transcript written through
 * the session store the api gives it (session-store.ts), so a turn resumes where the last ended
 * from any api instance: the SDK's session is the model's memory, and the api's log is the record,
 * written from the events this harness yields. The prompt of a turn is therefore not the whole
 * log but what the session hasn't got of it: the entries after the seq the session kept, less what
 * the turn that kept it said and what its calls answered, which the model remembers, and less
 * what the api summarized, since the model compacts its own context. What the person said and an
 * event, with its lead-in, are given as the api's own harness would send them; a wake-up after a
 * sleep says so, and a turn with nothing new says to go on. The pictures the person attached to
 * what the session hasn't got go with the prompt, as one message of theirs. What the log has of the model's own
 * doing that the session can't be known to have is written out before them as the record, the
 * calls with what they answered, for the model to go on from rather than do again: the steps of an
 * attempt at the turn that was cut short, the worker having died or the model gone out of reach,
 * with the api's closing of the calls it left open; an answer the api wrote in the model's place;
 * and, for a thread without a session of this harness, which another harness ran so far or whose
 * first turn here was cut short, the whole log as the model would read it, from its last summary
 * on.
 *
 * The model's tools are the api's (`ToolSurface`), served to the subprocess over an MCP server in
 * this process, which the SDK connects to the binary over stdio: every call the model makes comes
 * back here, is run through the surface's `execute`, and is answered in place, so the turn goes on
 * to the next step without the api's jobs; a call that ends the turn, a sleep, has the query
 * interrupted once its result is in. Claude Code's built-in tools are all removed, and a call to
 * anything but the api's tools is denied. The subprocess gets an environment of its own, not this
 * process's: the server's keys must never reach a member's subprocess, so only PATH and HOME are
 * inherited, with the credential the turn was given, a config directory of the harness's own,
 * kept across turns so the binary's install and device ids stay what they are, as an install's
 * do, with the binary's own copy of each turn's transcript removed after the turn (the store has
 * it), and the switches that keep it from reaching out beyond the model. Each thread has a working directory of its own, whose name is the key the
 * session is kept under in the store: the thread's id. A turn that fails before the api has a
 * session to keep deletes from the store the session it started, which nothing would resume. The
 * SDK runs only Claude: the harness lists the latest Sonnet, Opus and Fable, and a turn is run on
 * the one the api gives it, of those, which may be another than the session's last turn ran on. What Anthropic says of the member's plan as the turn runs, the
 * rate-limit headers the binary reports as events, is passed on as `usage` events, for the api to
 * show on the Account page; on an API key the binary reports none. A request Anthropic turns down
 * because the account is at its limit ends the turn saying so, with when the limit resets where
 * the binary said, and is not worth trying again: the binary has tried by then, and the plan's
 * window doesn't open for another try.
 */

/** What a turn is asked with: words, or, with pictures, the one message of the person's that carries them. */
export type SdkPrompt = string | AsyncIterable<SDKUserMessage>;

/** The SDK's `query`, or a test's: what a turn runs through, read as a stream of SDK messages, with the interrupt that ends a turn early. */
export type SdkQuery = (params: {prompt: SdkPrompt; options?: Options}) => AsyncIterable<SDKMessage> & {interrupt: () => Promise<unknown>};

/** What the harness runs with: the session store, where its subprocesses work and keep their config, how many turns run at once, and the SDK's `query` or a test's. */
export type ClaudeAgentSdkDeps = {
	sessionStore: SdkSessionStore;
	/** Under which each thread gets a working directory of its own. */
	workDir: string;
	/** The binary's config directory, kept across turns: its ids and settings stay, each turn's local transcript is removed. */
	configDir: string;
	/** The binary to run, where the SDK's own isn't the one. */
	pathToClaudeCodeExecutable?: string;
	/** How many turns, each a subprocess of a few hundred megabytes, one process runs at once. */
	maxConcurrentTurns: number;
	query?: SdkQuery;
};

export const CLAUDE_AGENT_SDK = 'claude-agent-sdk';

// The MCP server the api's tools are served on, and how its tools are named to the model.
const SERVER = 'proxy';
const TOOL_PREFIX = `mcp__${SERVER}__`;

// A step of the model's in the log: what it said, with its calls, or what a call answered.
const STEP_KINDS = new Set<ContextEntry['kind']>(['assistant', 'tool_result']);

// The models a member's Claude account answers with, each the latest of its line, by the id a
// persona keeps it under; and each as the SDK is told it, the full model id, so that what answers
// is what the label says, whatever the binary takes a bare `sonnet` to mean.
const MODELS: HarnessBackend['models'] = [
	{id: 'sonnet', label: 'Claude Sonnet 5.5', images: true},
	{id: 'opus', label: 'Claude Opus 5.5', images: true},
	{id: 'fable', label: 'Claude Fable 5.2', images: true},
];
const DEFAULT_SDK_MODEL = 'claude-sonnet-5-5';
const SDK_MODELS = new Map([
	['sonnet', DEFAULT_SDK_MODEL],
	['opus', 'claude-opus-5-5'],
	['fable', 'claude-fable-5-2'],
]);

// How long the SDK is given after the result to wind up, the transcript's mirroring among it,
// before the subprocess is stopped.
const WIND_UP_MS = 10_000;

const GO_ON = 'Go on.';

// What leads in the part of the log written out for the model, and what came after it.
const RECORD =
	'What follows is the record of this conversation where your own memory of it stops short, written out: you are the agent in it, and it has what was said, the calls you made and what they answered. You may remember some of it. Take it as what happened: don’t make a call again that was answered, and go on from where it ends.';
const SINCE = 'That is where the record ends. What came since, for you to answer now:';

// An assistant message's error that is the credential turned down, one that is the API out of
// reach for now, worth trying again, and the one that is the member's account at its limit, which
// the binary has tried again itself by then and trying once more wouldn't lift.
const CREDENTIAL_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'account_on_hold', 'verification_required']);
const UNREACHABLE_ERRORS = new Set(['overloaded', 'server_error']);
const LIMIT_ERROR = 'rate_limit';

// What a failure the binary reported says when the account was at its limit, and when the API was
// out of reach rather than refusing.
const LIMIT_WORDS = /rate.?limit|too many requests|usage limit|hit your limit/i;
const UNREACHABLE_WORDS = /overloaded|unreachable|could not (be )?reach|ECONN|ENOTFOUND|ETIMEDOUT|timed out|fetch failed|network|\b(500|502|503|504|529)\b/i;

// What the session keeps between turns: the seq of the last entry the model was given, and the
// job of the turn that kept it, whose own steps come after that seq in the log.
const sessionStateSchema = z.object({lastSeq: z.number().int().nonnegative(), job: z.string()});

type Session = {id: string; lastSeq: number; job: string};

// The thread's session, where it has one that is this harness's: a session whose state isn't one
// is treated as none, so the turn starts a session afresh and gives the model the log as the
// record, which loses nothing of it.
function sessionOf(input: HarnessTurn): Session | null {
	if (input.session === null) {
		return null;
	}
	const state = sessionStateSchema.safeParse(input.session.state);
	if (!state.success) {
		return null;
	}
	return {id: input.session.id, ...state.data};
}

// What the session hasn't got of the log: all of it without a session; with one, what came after
// the seq it kept, but the steps of the turn that kept it, which the model remembers, and the
// api's summaries, which stand for what the model compacts itself.
function unseenBy(session: Session | null, entries: HarnessEntry[]): HarnessEntry[] {
	if (session === null) {
		return entries;
	}
	return entries.filter((entry) => entry.seq > session.lastSeq && entry.kind !== 'summary' && !(STEP_KINDS.has(entry.kind) && entry.jobId === session.job));
}

// An entry that came to the model as the prompt has it: what the person said, or an event with
// its lead-in.
function pieceOf(subAgents: SubAgent[], entry: HarnessEntry): string[] {
	if (entry.kind === 'person') {
		return [entry.text];
	}
	if (entry.kind === 'event') {
		return [`${eventLead(subAgents, entry)}\n\n${entry.text}`];
	}
	return [];
}

// The prompt: what the session hasn't got of the log. Where that holds steps of the model's own,
// the log through the last of them is written out as the record (module comment); what came after
// it, a wake-up's note among it, is what the turn is to answer, or "Go on." where nothing did.
function promptFor(input: HarnessTurn, session: Session | null, now: Date): string {
	const subAgents = input.subAgents ?? [];
	const unseen = unseenBy(session, input.entries);
	const lastStep = unseen.findLastIndex((entry) => STEP_KINDS.has(entry.kind));
	const news = unseen.slice(lastStep + 1).flatMap((entry) => pieceOf(subAgents, entry));
	if (input.woken) {
		news.push(`You were woken, and it is now ${now.toISOString()}.`);
	}
	if (lastStep === -1) {
		return news.length === 0 ? GO_ON : news.join('\n\n');
	}
	const record = unseen.filter((entry, index) => index <= lastStep || entry.kind === 'summary');
	return [RECORD, toTranscript(record, subAgents), ...(news.length === 0 ? [GO_ON] : [SINCE, ...news])].join('\n\n');
}

/**
 * The prompt as the SDK takes it: the words alone where the person attached no pictures the
 * session hasn't got; with pictures, one message of the person's, each picture under its file's
 * name and the words after them. A message given this way is the turn's whole input: the SDK
 * closes the binary's input once the run it starts has ended, as it does after words alone.
 */
function withPictures(input: HarnessTurn, session: Session | null, words: string): SdkPrompt {
	const pictures: EntryImage[] = unseenBy(session, input.entries).flatMap((entry) => (entry.kind === 'person' ? (entry.images ?? []) : []));
	if (pictures.length === 0) {
		return words;
	}
	const content: ContentBlockParam[] = [
		...pictures.flatMap((picture): ContentBlockParam[] => [
			{type: 'text', text: `${picture.name}:`},
			{type: 'image', source: {type: 'base64', media_type: picture.mediaType, data: picture.data}},
		]),
		{type: 'text', text: words},
	];
	const message: SDKUserMessage = {type: 'user', message: {role: 'user', content}, parent_tool_use_id: null};
	return (async function* () {
		yield message;
	})();
}

// The credential as the binary reads it from its environment.
function credentialEnv(auth: HarnessAuth): Record<string, string> {
	if (auth.kind === 'api_key') {
		return {ANTHROPIC_API_KEY: auth.key};
	}
	return {CLAUDE_CODE_OAUTH_TOKEN: auth.accessToken, ...(auth.scopes.length === 0 ? {} : {CLAUDE_CODE_OAUTH_SCOPES: auth.scopes.join(' ')})};
}

// The subprocess's environment, which replaces this process's: only PATH and HOME are inherited,
// so no key of the server's reaches a member's subprocess, where the model could read it out.
function envFor(configDir: string, input: HarnessTurn, auth: HarnessAuth): Record<string, string> {
	const inherited = Object.fromEntries(
		['PATH', 'HOME'].flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
	return {
		...inherited,
		CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_CODE_PROJECT_DIR_NAME: input.thread.id,
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
		CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		DISABLE_TELEMETRY: '1',
		...credentialEnv(auth),
	};
}

// A failure of a call, as the model is told it.
function describe(error: ApiError): string {
	if ('message' in error && error.message !== undefined) {
		return error.message;
	}
	return `The call failed (${error.kind}).`;
}

/**
 * The api's tools as an MCP server in this process, for the SDK to connect to the binary: the
 * tools listed with their JSON Schema as they are, each marked to be loaded always, since the
 * binary otherwise defers an MCP server's tools behind its tool search, which is among the
 * built-in tools removed; a call run through the surface, under the id the binary gives the call,
 * so the result the api writes answers the call the model made. `answered` is told of each call
 * answered, with the answer, so the turn can end on one that ends it.
 */
export function proxyToolServer(tools: ToolSurface, answered: (callId: string, answer: ToolAnswer) => void): McpServer {
	const server = new McpServer({name: SERVER, version: '1.0.0'}, {capabilities: {tools: {}}});
	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: {...tool.inputSchema, type: 'object' as const},
			annotations: {readOnlyHint: tool.readOnly},
			_meta: {'anthropic/alwaysLoad': true},
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const toolUseId = request.params._meta?.['claudecode/toolUseId'];
		const id = typeof toolUseId === 'string' ? toolUseId : randomUUID();
		const answer = await tools.execute({id, name: request.params.name, arguments: JSON.stringify(request.params.arguments ?? {})});
		if (answer.isErr()) {
			return {content: [{type: 'text', text: describe(answer.error)}], isError: true};
		}
		answered(id, answer.value);
		return {content: [{type: 'text', text: answer.value.text}], isError: answer.value.isError};
	});
	return server;
}

// The one gate on calls: the binary asks before every call, and only the api's tools may run,
// trust keyed on the server being the one this process registered, where the binary says so; a
// tool the model hasn't got is denied. Nothing is pre-approved with `allowedTools`, which would
// take the binary's asking away from this gate.
const canUseTool: CanUseTool = async (toolName, _input, {mcpServer}) => {
	const ours = mcpServer === undefined ? toolName.startsWith(TOOL_PREFIX) : mcpServer.source === 'sdk' && mcpServer.name === SERVER;
	if (ours) {
		return {behavior: 'allow'};
	}
	return {behavior: 'deny', message: `${toolName} is not available here. The tools you have are those of the ${SERVER} server.`};
};

// A tool's name as the api knows it, from the name the binary gives an MCP tool.
function unprefixed(name: string): string {
	return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

// The results of calls a user message of the binary's carries, if any.
function toolResultsOf(content: MessageParam['content']): ToolResultBlockParam[] {
	if (typeof content === 'string') {
		return [];
	}
	return content.flatMap((block) => (block.type === 'tool_result' ? [block] : []));
}

// A result's text: its text blocks, joined.
function textOf(content: ToolResultBlockParam['content']): string {
	if (content === undefined) {
		return '';
	}
	if (typeof content === 'string') {
		return content;
	}
	return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function failed(error: ApiError, retry: boolean): HarnessEvent {
	return {kind: 'failed', error, retry};
}

// The plan's window a rate-limit event speaks of, as the event names it; the per-model and
// overage windows the binary also reports are left out.
function windowOf(type: SDKRateLimitInfo['rateLimitType']): 'fiveHour' | 'sevenDay' | null {
	if (type === 'five_hour') {
		return 'fiveHour';
	}
	if (type === 'seven_day') {
		return 'sevenDay';
	}
	return null;
}

// What the binary said of the member's plan, as a usage event, where it spoke of one of the
// windows shown, with how much is used; the reset comes as unix seconds. Null for anything else.
function usageOf(info: SDKRateLimitInfo): HarnessEvent | null {
	const window = windowOf(info.rateLimitType);
	if (window === null || typeof info.utilization !== 'number') {
		return null;
	}
	const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null;
	return {kind: 'usage', [window]: {utilization: info.utilization, resetsAt}};
}

// The member's account at its limit: not worth trying again as it is, with when the limit resets
// where the binary said.
function limitReached(text: string, resetsAt: Date | null): HarnessEvent {
	return {kind: 'failed', error: ApiErr.providerUnreachable(new Error(text)), retry: false, limitReached: {resetsAt}};
}

// When the limit resets that the binary said the plan hit, turning the request down for it; null
// for any other word of the plan, and where it didn't say when.
function rejectedUntil(info: SDKRateLimitInfo): Date | null {
	if (info.status !== 'rejected' || typeof info.resetsAt !== 'number') {
		return null;
	}
	return new Date(info.resetsAt * 1000);
}

// A failure the binary reported in words: the account at its limit says so, and the API out of
// reach is worth trying again.
function reported(text: string, resetsAt: Date | null): HarnessEvent {
	if (LIMIT_WORDS.test(text)) {
		return limitReached(text, resetsAt);
	}
	if (UNREACHABLE_WORDS.test(text)) {
		return failed(ApiErr.providerUnreachable(new Error(text)), true);
	}
	return failed(ApiErr.internalError(new Error(text)), false);
}

// The turn's end, from the binary's result: done where the turn ran to its end, hit the cap on
// steps, which the api handles, or was interrupted after a sleep; a failure otherwise. The input
// counted is everything the model read, the cache's part of it included, since that is what the
// turn cost in context.
function endOf(message: SDKResultMessage, context: {sessionId: string; lastSeq: number; job: string; system: string; interrupted: boolean; resetsAt: Date | null}): HarnessEvent {
	if (message.subtype === 'success' && message.is_error && !context.interrupted) {
		return reported(message.result, context.resetsAt);
	}
	if (message.subtype !== 'success' && message.subtype !== 'error_max_turns' && !context.interrupted) {
		return reported(message.errors.join('; ') || message.subtype, context.resetsAt);
	}
	const {usage} = message;
	return {
		kind: 'done',
		session: {id: context.sessionId, state: {lastSeq: context.lastSeq, job: context.job}},
		system: context.system,
		inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
		outputTokens: usage.output_tokens,
	};
}

// What an assistant message's error ends the turn with, if it does: a credential turned down,
// the account at its limit, or the API out of reach. Other errors run their course to the result.
function assistantFailure(error: string | undefined, resetsAt: Date | null): HarnessEvent | null {
	if (error === undefined) {
		return null;
	}
	if (CREDENTIAL_ERRORS.has(error)) {
		return failed(ApiErr.credentialsRejected(), false);
	}
	if (error === LIMIT_ERROR) {
		return limitReached(`The model answered with ${error}`, resetsAt);
	}
	if (UNREACHABLE_ERRORS.has(error)) {
		return failed(ApiErr.providerUnreachable(new Error(`The model answered with ${error}`)), true);
	}
	return null;
}

// Reads the rest of the binary's messages after the result, so the SDK finishes what it does as
// the subprocess exits, the transcript's mirroring to the session store among it; a subprocess
// that lingers is stopped after a while.
// Removes the binary's local copy of a session's transcript from the config directory: the
// session's file under the project named for the thread, and the directory of its sub-agents'
// files beside it, where there is one. Best effort: a copy left behind costs disk, nothing else.
async function removeLocalTranscript(configDir: string, threadId: string, sessionId: string): Promise<void> {
	const project = join(configDir, 'projects', threadId);
	await Result.wrapAsync(async () => {
		await rm(join(project, `${sessionId}.jsonl`), {force: true});
		await rm(join(project, sessionId), {recursive: true, force: true});
	});
}

async function windUp(iterator: AsyncIterator<SDKMessage>, controller: AbortController): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The stream is given so long and no longer, whether or not it ends when told: a subprocess
	// that lingers is stopped, and one whose stream never ends is left behind rather than holding
	// the worker.
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve();
		}, WIND_UP_MS);
	});
	const drained = Result.wrapAsync(async () => {
		let step = await iterator.next();
		while (!step.done) {
			step = await iterator.next();
		}
	}).then(() => undefined);
	await Promise.race([drained, deadline]);
	clearTimeout(timer);
}

export function claudeAgentSdkHarness(deps: ClaudeAgentSdkDeps): HarnessBackend {
	const query: SdkQuery = deps.query ?? sdkQuery;
	return {
		id: CLAUDE_AGENT_SDK,
		label: 'Claude',
		models: MODELS,
		stepsPerTurn: 'many',
		maxConcurrentTurns: deps.maxConcurrentTurns,
		turn: async function* (input) {
			if (input.signal.aborted) {
				yield failed(ApiErr.providerUnreachable(new Error('The turn was stopped before the model was asked')), true);
				return;
			}
			// The api gives this harness no turn without a credential (its backends/harness.ts);
			// one without is the member's credential missing, which the api answers as a credential
			// turned down.
			const {auth} = input;
			if (auth === undefined) {
				yield failed(ApiErr.credentialsRejected(), false);
				return;
			}
			const session = sessionOf(input);
			const cwd = join(deps.workDir, input.thread.id);
			const made = await Result.wrapAsync(async () => {
				await mkdir(cwd, {recursive: true});
				await mkdir(deps.configDir, {recursive: true});
			});
			if (made.isErr()) {
				yield failed(ApiErr.internalError(made.error), false);
				return;
			}
			// The calls whose answer ends the turn, by id, as the server answers them.
			const endsTurn = new Set<string>();
			const server = proxyToolServer(input.tools, (callId, answer) => {
				if (answer.endTurn) {
					endsTurn.add(callId);
				}
			});
			const controller = new AbortController();
			const onAbort = (): void => controller.abort();
			input.signal.addEventListener('abort', onAbort, {once: true});
			const options: Options = {
				systemPrompt: input.system,
				tools: [],
				mcpServers: {[SERVER]: {type: 'sdk', name: SERVER, instance: server}},
				canUseTool,
				permissionMode: 'default',
				settingSources: [],
				strictMcpConfig: true,
				maxTurns: input.maxSteps,
				...(session === null ? {} : {resume: session.id}),
				sessionStore: deps.sessionStore,
				cwd,
				env: envFor(deps.configDir, input, auth),
				...(deps.pathToClaudeCodeExecutable === undefined ? {} : {pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable}),
				abortController: controller,
				model: SDK_MODELS.get(input.model) ?? DEFAULT_SDK_MODEL,
			};
			const lastSeq = input.entries.at(-1)?.seq ?? session?.lastSeq ?? 0;
			const open = new Set<string>();
			let sessionId = session?.id ?? null;
			// When the limit the binary last said the account hit resets, for a failure that follows.
			let resetsAt: Date | null = null;
			let interrupted = false;
			let ended = false;
			let done = false;
			const started = Result.wrap(() => query({prompt: withPictures(input, session, promptFor(input, session, new Date())), options}));
			if (started.isErr()) {
				input.signal.removeEventListener('abort', onAbort);
				yield failed(ApiErr.providerUnreachable(started.error), true);
				return;
			}
			const run = started.value;
			const iterator = run[Symbol.asyncIterator]();
			try {
				while (!ended) {
					const next = await Result.wrapAsync(() => iterator.next());
					if (next.isErr()) {
						yield failed(ApiErr.providerUnreachable(next.error), true);
						return;
					}
					if (next.value.done) {
						yield failed(ApiErr.providerUnreachable(new Error('The SDK ended the turn without a result')), true);
						return;
					}
					const message = next.value.value;
					if (message.type === 'system' && message.subtype === 'init') {
						sessionId = message.session_id;
						continue;
					}
					if (message.type === 'rate_limit_event') {
						resetsAt = rejectedUntil(message.rate_limit_info) ?? resetsAt;
						const usage = usageOf(message.rate_limit_info);
						if (usage !== null) {
							yield usage;
						}
						continue;
					}
					if (message.type === 'assistant') {
						if (message.parent_tool_use_id !== null) {
							continue;
						}
						const failure = assistantFailure(message.error, resetsAt);
						if (failure !== null) {
							yield failure;
							return;
						}
						for (const block of message.message.content) {
							if (block.type === 'text' && block.text !== '') {
								yield {kind: 'text', text: block.text};
							}
							if (block.type === 'tool_use') {
								open.add(block.id);
								yield {kind: 'tool_call', id: block.id, name: unprefixed(block.name), arguments: JSON.stringify(block.input) ?? '{}'};
							}
						}
						continue;
					}
					if (message.type === 'user') {
						if (message.parent_tool_use_id !== null) {
							continue;
						}
						for (const result of toolResultsOf(message.message.content)) {
							// A result for a call this turn didn't make is the binary's own, as a replay
							// of the prompt, and not the log's.
							if (!open.delete(result.tool_use_id)) {
								continue;
							}
							yield {kind: 'tool_result', callId: result.tool_use_id, text: textOf(result.content), isError: result.is_error === true};
							if (endsTurn.has(result.tool_use_id)) {
								interrupted = true;
								await Result.wrapAsync(() => run.interrupt());
							}
						}
						continue;
					}
					if (message.type === 'result') {
						ended = true;
						await windUp(iterator, controller);
						const end = endOf(message, {sessionId: sessionId ?? message.session_id, lastSeq, job: input.job, system: input.system, interrupted, resetsAt});
						done = end.kind === 'done';
						yield end;
					}
				}
			} finally {
				input.signal.removeEventListener('abort', onAbort);
				// A turn left before its result, on a failure, takes its subprocess down with it, and
				// waits for the SDK to end, so nothing of the turn is mirrored after what follows.
				if (!ended) {
					controller.abort();
					await windUp(iterator, controller);
				}
				// A session this turn started and the api won't keep, since the turn failed, is deleted
				// from the store, where nothing would ever resume it: the turn tried again starts one
				// afresh, on the log as the record, what this attempt did among it. As best it can, since
				// the turn's outcome is told already. The key is the thread's id (CLAUDE_CODE_PROJECT_DIR_NAME).
				const orphan = sessionId;
				if (!done && orphan !== null && orphan !== session?.id) {
					await Result.wrapAsync(() => deps.sessionStore.delete({projectKey: input.thread.id, sessionId: orphan}));
				}
				// The binary's own copy of the turn's transcript, under the project named for the thread,
				// is removed: the store has it, and a config directory kept across turns would otherwise
				// fill with one file per turn. A run resumed from the store leaves none here.
				if (sessionId !== null) {
					await removeLocalTranscript(deps.configDir, input.thread.id, sessionId);
				}
			}
		},
	};
}
