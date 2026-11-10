import {randomUUID} from 'node:crypto';
import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {type CanUseTool, type Options, query as sdkQuery, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage} from '@anthropic-ai/claude-agent-sdk';
import type {MessageParam, ToolResultBlockParam} from '@anthropic-ai/sdk/resources';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';
import {isInterruptedResult} from '@proxy/utils/harness';
import {type ContextEntry, eventLead, type SubAgent} from '@proxy/utils/harness-context';

import type {HarnessAuth, HarnessBackend, HarnessEvent, HarnessTurn, ToolAnswer, ToolSurface} from './backend';
import type {SdkSessionStore} from './session-store';

/**
 * The harness on the Claude Agent SDK: a turn is one `query()` of the SDK, which spawns Claude
 * Code's own binary as a subprocess and talks to it over stdio, run as the member, on the Claude
 * credential they connected. The SDK keeps a session per thread, its transcript written through
 * the session store the api gives it (session-store.ts), so a turn resumes where the last ended
 * from any api instance: the SDK's session is the model's memory, and the api's log is the record,
 * written from the events this harness yields. The prompt of a turn is therefore not the whole
 * log but what came since the session last saw it, the entries after the seq the session kept,
 * rendered as text the way the api's own harness would send them, an event with its lead-in; a
 * wake-up after a sleep says so, and a turn with nothing new says to go on. What the model itself
 * said, what its calls answered and what the api summarized are left out: the model remembers the
 * first two, and compacts its own context in place of the third. The one result told is the api's
 * closing of a call that a worker died in the middle of, which the model's own transcript hasn't
 * got.
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
 * model is Sonnet throughout: the SDK runs only Claude, so the api's choice of another model for a
 * persona doesn't apply here. What Anthropic says of the member's plan as the turn runs, the
 * rate-limit headers the binary reports as events, is passed on as `usage` events, for the api to
 * show on the Account page; on an API key the binary reports none.
 */

/** The SDK's `query`, or a test's: what a turn runs through, read as a stream of SDK messages, with the interrupt that ends a turn early. */
export type SdkQuery = (params: {prompt: string; options?: Options}) => AsyncIterable<SDKMessage> & {interrupt: () => Promise<unknown>};

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

// The model, as the SDK names it on a subscription: the persona's Claude, Sonnet 5.5.
const MODEL = 'sonnet';

// How long the SDK is given after the result to wind up, the transcript's mirroring among it,
// before the subprocess is stopped.
const WIND_UP_MS = 10_000;

const GO_ON = 'Go on.';

// An assistant message's error that is the credential turned down, and one that is the API out
// of reach for now, worth trying again.
const CREDENTIAL_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'account_on_hold', 'verification_required']);
const UNREACHABLE_ERRORS = new Set(['rate_limit', 'overloaded', 'server_error']);

// What a failure the binary reported says when the API was out of reach rather than refusing.
const UNREACHABLE_WORDS = /overloaded|rate.?limit|too many requests|unreachable|could not (be )?reach|ECONN|ENOTFOUND|ETIMEDOUT|timed out|fetch failed|network|\b(500|502|503|504|529)\b/i;

// What the session keeps between turns: the seq of the last entry the model was given.
const sessionStateSchema = z.object({lastSeq: z.number().int().nonnegative()});

type Session = {id: string; lastSeq: number};

// The thread's session, where it has one that is this harness's: a session whose state isn't one
// is treated as none, so the turn starts a session afresh and gives the model the whole log as
// its prompt, which loses nothing of the record.
function sessionOf(input: HarnessTurn): Session | null {
	if (input.session === null) {
		return null;
	}
	const state = sessionStateSchema.safeParse(input.session.state);
	if (!state.success) {
		return null;
	}
	return {id: input.session.id, lastSeq: state.data.lastSeq};
}

// The tool a call was to, by its id, from the log.
function toolOf(entries: ContextEntry[], callId: string | null): string {
	return entries.flatMap((entry) => entry.toolCalls ?? []).find((call) => call.id === callId)?.name ?? 'unknown';
}

// An entry as the prompt has it: what the person said; an event with its lead-in; the api's
// closing of a call that a worker died in the middle of, which the model's transcript hasn't got.
// Nothing for what the model said, what its calls answered and a summary: the log after the seq
// the session kept holds the turn's own steps too, which the api wrote as the turn went, and the
// model has them in its own transcript. A result lost between the api's write and the SDK's
// mirror is marked interrupted by Claude Code itself on resume.
function pieceOf(entries: ContextEntry[], subAgents: SubAgent[], entry: ContextEntry): string | null {
	if (entry.kind === 'person') {
		return entry.text;
	}
	if (entry.kind === 'event') {
		return `${eventLead(subAgents, entry)}\n\n${entry.text}`;
	}
	if (entry.kind === 'tool_result' && isInterruptedResult(entry)) {
		return `Your call ${entry.callId ?? ''} (${toolOf(entries, entry.callId)}) was not answered: ${entry.text}`;
	}
	return null;
}

// The prompt: what came since the session last saw the log, a wake-up's note, or "Go on."
function promptFor(input: HarnessTurn, lastSeq: number, now: Date): string {
	const subAgents = input.subAgents ?? [];
	const pieces = input.entries
		.filter((entry) => entry.seq > lastSeq)
		.flatMap((entry) => {
			const piece = pieceOf(input.entries, subAgents, entry);
			return piece === null ? [] : [piece];
		});
	if (input.woken) {
		pieces.push(`You were woken, and it is now ${now.toISOString()}.`);
	}
	return pieces.length === 0 ? GO_ON : pieces.join('\n\n');
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

// A failure the binary reported in words: the API out of reach is worth trying again.
function reported(text: string): HarnessEvent {
	if (UNREACHABLE_WORDS.test(text)) {
		return failed(ApiErr.providerUnreachable(new Error(text)), true);
	}
	return failed(ApiErr.internalError(new Error(text)), false);
}

// The turn's end, from the binary's result: done where the turn ran to its end, hit the cap on
// steps, which the api handles, or was interrupted after a sleep; a failure otherwise. The input
// counted is everything the model read, the cache's part of it included, since that is what the
// turn cost in context.
function endOf(message: SDKResultMessage, context: {sessionId: string; lastSeq: number; system: string; interrupted: boolean}): HarnessEvent {
	if (message.subtype === 'success' && message.is_error && !context.interrupted) {
		return reported(message.result);
	}
	if (message.subtype !== 'success' && message.subtype !== 'error_max_turns' && !context.interrupted) {
		return reported(message.errors.join('; ') || message.subtype);
	}
	const {usage} = message;
	return {
		kind: 'done',
		session: {id: context.sessionId, state: {lastSeq: context.lastSeq}},
		system: context.system,
		inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
		outputTokens: usage.output_tokens,
	};
}

// What an assistant message's error ends the turn with, if it does: a credential turned down,
// or the API out of reach. Other errors run their course to the result.
function assistantFailure(error: string | undefined): HarnessEvent | null {
	if (error === undefined) {
		return null;
	}
	if (CREDENTIAL_ERRORS.has(error)) {
		return failed(ApiErr.credentialsRejected(), false);
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
				model: MODEL,
			};
			const lastSeq = input.entries.at(-1)?.seq ?? session?.lastSeq ?? 0;
			const open = new Set<string>();
			let sessionId = session?.id ?? null;
			let interrupted = false;
			let ended = false;
			let done = false;
			const started = Result.wrap(() => query({prompt: promptFor(input, session?.lastSeq ?? 0, new Date()), options}));
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
						const failure = assistantFailure(message.error);
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
						const end = endOf(message, {sessionId: sessionId ?? message.session_id, lastSeq, system: input.system, interrupted});
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
				// from the store, where nothing would ever resume it; as best it can, since the turn's
				// outcome is told already. The key is the thread's id (CLAUDE_CODE_PROJECT_DIR_NAME).
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
