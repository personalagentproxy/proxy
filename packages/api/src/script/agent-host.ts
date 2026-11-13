import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {SANDBOX_INTEGRATION_ID} from '@proxy/integrations';
import type {SignedInAgent} from '@proxy/db/agent';
import type {PapMethod} from '@proxy/contracts/cli';

import {sendAgentFeedback} from '../agent-side/feedback';
import {connectionSummary, toolSummary} from '../agent-side/summaries';
import {finishAgentTask, requireOpenTask, startAgentTask} from '../agent-side/tasks';
import {type AgentCaller, agentViewer, listAgentConnections, listAgentTools, runAgentTool} from '../agent-side/tools';
import {log, serializeError} from '../observability/log';
import {loadConnection} from '../records/target';
import {jsonSchema, type Json} from './protocol';
import type {PapAnswer, ScriptHost} from './run-script';

/**
 * A script's `pap` functions, answered for the agent through the same gate as every call it
 * makes, and into the same log:
 * - `pap.startTask({title, goal, parent?})`: starts a task. Without `parent`, the rest of the
 *   script is for it; with one, it is a sub-task to hand to a sub-agent, and the script's task
 *   stays as it was.
 * - `pap.finishTask({outcome?})`: finishes the script's task.
 * - `pap.connections()`: the connections the agent can use.
 * - `pap.tools(connection)`: a connection's tools.
 * - `pap.call(connection, tool, params?)`: runs a tool, one that reads or one that changes something.
 * - `pap.feedback({message, connection?, tool?})`: feedback for the makers of Personal Agent Proxy.
 * The task is the run's: the one it was started for, or the one the script started, kept here,
 * so a script can only use its agent's own, as any call can. The built-in agent's sub-agents
 * have a task the loop keeps for them, so theirs start and finish none. Code in a sandbox calling
 * these over HTTP (cli/route.ts) has its task fixed by its token too, and reaches no Sandboxes
 * connection: `connections` leaves them out, and their tools are refused.
 */

/** Which way the calls came in: the MCP server, the agent page, the built-in agent's loop, or a sandbox's CLI. */
export type ScriptVia = AgentCaller['via'];

// The agent page keeps the task for the agent, so there is no `task` to give there.
const noTask = (via: ScriptVia) => (via === 'web' ? 'No task: call pap.startTask first.' : 'No task: call pap.startTask first, or give `task`.');
const OWN_TASK = 'Your task is kept for you.';
const NO_SANDBOXES = 'Sandboxes can’t be used from inside a sandbox: run sandbox_exec from outside it.';

const ARGS = {
	connections: z.tuple([]),
	tools: z.tuple([z.string().min(1)]),
	call: z.tuple([z.string().min(1), z.string().min(1), z.record(z.string(), jsonSchema).optional()]),
	startTask: z.tuple([z.object({title: z.string(), goal: z.string(), parent: z.string().optional()})]),
	finishTask: z.tuple([z.object({outcome: z.string().optional()}).optional()]),
	feedback: z.tuple([z.object({message: z.string(), connection: z.string().optional(), tool: z.string().optional()})]),
};

// How a model calls each `pap` function, as a script's (`pap.tools(connection)`) or the CLI's
// command (`pap tools <connection>`), so what it is told names what it can run. Code in a sandbox
// never starts or finishes a task, so the CLI has no command for either.
const SCRIPT_USAGE: Record<PapMethod, string> = {
	connections: 'pap.connections()',
	tools: 'pap.tools(connection)',
	call: 'pap.call(connection, tool, params)',
	startTask: 'pap.startTask({title, goal, parent?})',
	finishTask: 'pap.finishTask({outcome?})',
	feedback: 'pap.feedback({message, connection?, tool?})',
};

const CLI_USAGE: Record<PapMethod, string> = {
	...SCRIPT_USAGE,
	connections: '`pap connections`',
	tools: '`pap tools <connection>`',
	call: '`pap call <connection> <tool> [json]`',
	feedback: '`pap feedback <message> [--connection <id>] [--tool <name>]`',
};

function usageFor(via: ScriptVia): Record<PapMethod, string> {
	return via === 'cli' ? CLI_USAGE : SCRIPT_USAGE;
}

function argsOf<T>(via: ScriptVia, method: PapMethod, schema: z.ZodType<T>, args: Json[]): Result<T, ApiError> {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		return Err(ApiErr.validationError(`Takes ${usageFor(via)[method]}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}`));
	}
	return Ok(parsed.data);
}

/**
 * What went wrong, in words a model can act on: what to call instead, named as the way it came in
 * calls it (`usageFor`), or who can fix it.
 */
export function agentErrorMessage(error: ApiError, via: ScriptVia, tool?: string): string {
	const usage = usageFor(via);
	if (error.kind === 'not_found' && error.resource === 'connection') {
		return `No connection ${error.id ?? ''}; see ${usage.connections}.`;
	}
	if (error.kind === 'not_found' && error.resource === 'tool') {
		return `No tool ${error.id ?? ''}; see ${usage.tools}.`;
	}
	// Code in a sandbox has its command's task, which can only have ended.
	if (error.kind === 'not_found' && error.resource === 'task' && via === 'cli') {
		return `No task ${error.id ?? ''}.`;
	}
	if (error.kind === 'not_found' && error.resource === 'task') {
		return `No task ${error.id ?? ''}; start one with pap.startTask.`;
	}
	if (error.kind === 'not_found' && error.message) {
		return error.message;
	}
	if (error.kind === 'not_found') {
		return `No ${error.resource}${error.id ? ` ${error.id}` : ''}.`;
	}
	if (error.kind === 'forbidden') {
		return `Not allowed: ${tool ?? 'that'}. The person who made this login can allow it.`;
	}
	if (error.kind === 'validation_error' || error.kind === 'parse_error' || error.kind === 'conflict') {
		return error.message;
	}
	if (error.kind === 'credentials_rejected') {
		return 'Sign-in rejected: the person must reconnect this account. Retrying won’t help.';
	}
	if (error.kind === 'provider_unreachable') {
		return error.message ?? 'The provider could not be reached; try again.';
	}
	if (error.kind === 'unauthenticated') {
		return 'This login is signed out.';
	}
	if (error.kind === 'unavailable') {
		return error.message;
	}
	log.error('A pap call failed', {kind: error.kind, ...('cause' in error ? serializeError(error.cause) : {})});
	return 'Something went wrong; try again.';
}

type HostState = {taskId: string | null; started: string | null; finished: boolean};

type HostOptions = {via: ScriptVia; task: string | null; taskTools: boolean; sandboxes: boolean};

// Refuses a Sandboxes connection, for calls from inside a sandbox; any other the agent sees passes.
function refuseSandboxes(signedIn: SignedInAgent, connectionId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {integration} = $(await loadConnection(agentViewer(signedIn), connectionId));
		if (integration.id === SANDBOX_INTEGRATION_ID) {
			return $(Err(ApiErr.validationError(NO_SANDBOXES)));
		}
	});
}

// What the call answers, any of the agent side's answers, which go to the script as JSON.
function answer(signedIn: SignedInAgent, options: HostOptions, state: HostState, method: PapMethod, args: Json[]): Promise<Result<object, ApiError>> {
	return Do(async ($) => {
		const caller = {agent: signedIn, via: options.via} as const;
		if ((method === 'startTask' || method === 'finishTask') && !options.taskTools) {
			return $(Err(ApiErr.validationError(OWN_TASK)));
		}
		if (method === 'startTask') {
			const [body] = $(argsOf(options.via, method, ARGS.startTask, args));
			const task = $(await startAgentTask(caller, body));
			if (body.parent === undefined) {
				state.taskId = task.task;
				state.started = task.task;
				state.finished = false;
			}
			return task;
		}
		if (method === 'feedback') {
			const [body] = $(argsOf(options.via, method, ARGS.feedback, args));
			return $(await sendAgentFeedback(caller, {...body, ...(state.taskId === null ? {} : {task: state.taskId})}));
		}
		const taskId = $(requirePresent(state.taskId, ApiErr.validationError(noTask(options.via))));
		if (method === 'finishTask') {
			const [body] = $(argsOf(options.via, method, ARGS.finishTask, args));
			const finished = $(await finishAgentTask(caller, {...body, task: taskId}));
			state.finished = true;
			return finished;
		}
		if (method === 'connections') {
			$(argsOf(options.via, method, ARGS.connections, args));
			const [task, listed] = await Promise.all([requireOpenTask(signedIn, taskId), listAgentConnections(signedIn)]);
			$(task);
			return $(listed)
				.connections.filter((one) => options.sandboxes || one.integrationId !== SANDBOX_INTEGRATION_ID)
				.map(connectionSummary);
		}
		if (method === 'tools') {
			const [connection] = $(argsOf(options.via, method, ARGS.tools, args));
			if (!options.sandboxes) {
				$(await refuseSandboxes(signedIn, connection));
			}
			const [task, tools] = await Promise.all([requireOpenTask(signedIn, taskId), listAgentTools(signedIn, connection)]);
			$(task);
			return $(tools).map(toolSummary);
		}
		const [connection, tool, params] = $(argsOf(options.via, method, ARGS.call, args));
		if (!options.sandboxes) {
			$(await refuseSandboxes(signedIn, connection));
		}
		return $(await runAgentTool({...caller, taskId}, connection, tool, params ?? {}));
	});
}

// What went wrong, for a tool run naming the tool and the connection first, so a script that ran
// several at once can tell which failed.
function callError(via: ScriptVia, method: PapMethod, args: Json[], error: ApiError): string {
	const [connection, tool] = args;
	if (method !== 'call' || typeof connection !== 'string' || typeof tool !== 'string') {
		return agentErrorMessage(error, via);
	}
	return `${tool} on ${connection}: ${agentErrorMessage(error, via, tool)}`;
}

/**
 * A script's `pap` functions; the task it started for itself, where it did; and the task its
 * calls were for at the end, null once it finished it.
 */
export type AgentScriptHost = {answer: ScriptHost; startedTask: () => string | null; task: () => string | null};

/**
 * The `pap` functions of a script the agent runs for `task`, or for the task the script starts
 * where none; `taskTools` whether it may start and finish tasks, and `sandboxes` whether it may
 * use Sandboxes connections.
 */
export function agentScriptHost(signedIn: SignedInAgent, options: HostOptions): AgentScriptHost {
	const state: HostState = {taskId: options.task, started: null, finished: false};
	return {
		answer: async (method, args): Promise<PapAnswer> => {
			const result = await answer(signedIn, options, state, method, args);
			if (result.isErr()) {
				return Err({kind: result.error.kind, message: callError(options.via, method, args, result.error)});
			}
			return Ok(JSON.stringify(result.value));
		},
		startedTask: () => state.started,
		task: () => (state.finished ? null : state.taskId),
	};
}
