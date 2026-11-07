import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';

import {sendAgentFeedback} from '../agent-side/feedback';
import {connectionSummary, toolSummary} from '../agent-side/summaries';
import {finishAgentTask, requireOpenTask, startAgentTask} from '../agent-side/tasks';
import {type AgentCaller, listAgentConnections, listAgentTools, runAgentTool} from '../agent-side/tools';
import {log, serializeError} from '../observability/log';
import {jsonSchema, type Json, type PapMethod} from './protocol';
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
 * have a task the loop keeps for them, so theirs start and finish none.
 */

/** Which way the script came in: the MCP server, or the built-in agent's loop. */
export type ScriptVia = Exclude<AgentCaller['via'], 'web'>;

const NO_TASK = 'Every call is made for a task. Start one first with `await pap.startTask({title, goal})`, or give the task you are on as `task`.';
const OWN_TASK = 'Your task is kept for you: there is no task to start or finish.';

const ARGS = {
	connections: z.tuple([]),
	tools: z.tuple([z.string().min(1)]),
	call: z.tuple([z.string().min(1), z.string().min(1), z.record(z.string(), jsonSchema).optional()]),
	startTask: z.tuple([z.object({title: z.string(), goal: z.string(), parent: z.string().optional()})]),
	finishTask: z.tuple([z.object({outcome: z.string().optional()}).optional()]),
	feedback: z.tuple([z.object({message: z.string(), connection: z.string().optional(), tool: z.string().optional()})]),
};

const USAGE: Record<PapMethod, string> = {
	connections: 'pap.connections()',
	tools: 'pap.tools(connection)',
	call: 'pap.call(connection, tool, params)',
	startTask: 'pap.startTask({title, goal, parent?})',
	finishTask: 'pap.finishTask({outcome?})',
	feedback: 'pap.feedback({message, connection?, tool?})',
};

function argsOf<T>(method: PapMethod, schema: z.ZodType<T>, args: Json[]): Result<T, ApiError> {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		return Err(ApiErr.validationError(`${USAGE[method]} is how it is called: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}`));
	}
	return Ok(parsed.data);
}

/** What went wrong, in words a model can act on: what to call instead, or who can fix it. */
export function errorMessage(error: ApiError, tool: string | undefined): string {
	if (error.kind === 'not_found' && error.resource === 'connection') {
		return `There is no connection ${error.id ?? ''} for this login: pap.connections() lists the ones it can use.`;
	}
	if (error.kind === 'not_found' && error.resource === 'tool') {
		return `This connection has no tool ${error.id ?? ''}: pap.tools(connection) lists the ones this login has with it.`;
	}
	if (error.kind === 'not_found' && error.resource === 'task') {
		return `There is no task ${error.id ?? ''} for this login: start one with pap.startTask({title, goal}).`;
	}
	if (error.kind === 'not_found' && error.message) {
		return error.message;
	}
	if (error.kind === 'not_found') {
		return `There is no ${error.resource}${error.id ? ` ${error.id}` : ''}.`;
	}
	if (error.kind === 'forbidden') {
		return `This login may not run ${tool ?? 'that'} with this connection: pap.tools(connection) lists what it may do, or ask the person who made the login for access.`;
	}
	if (error.kind === 'validation_error' || error.kind === 'parse_error' || error.kind === 'conflict') {
		return error.message;
	}
	if (error.kind === 'credentials_rejected') {
		return 'The provider turned this connection’s sign-in down. The person who made this login needs to reconnect it: trying again won’t help until they do.';
	}
	if (error.kind === 'provider_unreachable') {
		return error.message ?? 'The provider could not be reached. Try again in a moment.';
	}
	if (error.kind === 'unauthenticated') {
		return 'This login has been signed out.';
	}
	if (error.kind === 'unavailable') {
		return error.message;
	}
	log.error('A pap call failed', {kind: error.kind, ...('cause' in error ? serializeError(error.cause) : {})});
	return 'Something went wrong. Try again in a moment.';
}

type HostState = {taskId: string | null; started: string | null};

type HostOptions = {via: ScriptVia; task: string | null; taskTools: boolean};

// What the call answers, any of the agent side's answers, which go to the script as JSON.
function answer(signedIn: SignedInAgent, options: HostOptions, state: HostState, method: PapMethod, args: Json[]): Promise<Result<object, ApiError>> {
	return Do(async ($) => {
		const caller = {agent: signedIn, via: options.via} as const;
		if ((method === 'startTask' || method === 'finishTask') && !options.taskTools) {
			return $(Err(ApiErr.validationError(OWN_TASK)));
		}
		if (method === 'startTask') {
			const [body] = $(argsOf(method, ARGS.startTask, args));
			const task = $(await startAgentTask(caller, body));
			if (body.parent === undefined) {
				state.taskId = task.task;
				state.started = task.task;
			}
			return task;
		}
		if (method === 'feedback') {
			const [body] = $(argsOf(method, ARGS.feedback, args));
			return $(await sendAgentFeedback(caller, {...body, ...(state.taskId === null ? {} : {task: state.taskId})}));
		}
		const taskId = $(requirePresent(state.taskId, ApiErr.validationError(NO_TASK)));
		if (method === 'finishTask') {
			const [body] = $(argsOf(method, ARGS.finishTask, args));
			return $(await finishAgentTask(caller, {...body, task: taskId}));
		}
		if (method === 'connections') {
			$(argsOf(method, ARGS.connections, args));
			const [task, listed] = await Promise.all([requireOpenTask(signedIn, taskId), listAgentConnections(signedIn)]);
			$(task);
			return $(listed).connections.map(connectionSummary);
		}
		if (method === 'tools') {
			const [connection] = $(argsOf(method, ARGS.tools, args));
			const [task, tools] = await Promise.all([requireOpenTask(signedIn, taskId), listAgentTools(signedIn, connection)]);
			$(task);
			return $(tools).map(toolSummary);
		}
		const [connection, tool, params] = $(argsOf(method, ARGS.call, args));
		return $(await runAgentTool({...caller, taskId}, connection, tool, params ?? {}));
	});
}

// What went wrong, for a tool run naming the tool and the connection first, so a script that ran
// several at once can tell which failed.
function callError(method: PapMethod, args: Json[], error: ApiError): string {
	const [connection, tool] = args;
	if (method !== 'call' || typeof connection !== 'string' || typeof tool !== 'string') {
		return errorMessage(error, undefined);
	}
	return `${tool} on ${connection}: ${errorMessage(error, tool)}`;
}

/** A script's `pap` functions, and the task it started for itself, where it did. */
export type AgentScriptHost = {answer: ScriptHost; startedTask: () => string | null};

/**
 * The `pap` functions of a script the agent runs for `task`, or for the task the script starts
 * where none; `taskTools` whether it may start and finish tasks.
 */
export function agentScriptHost(signedIn: SignedInAgent, options: HostOptions): AgentScriptHost {
	const state: HostState = {taskId: options.task, started: null};
	return {
		answer: async (method, args): Promise<PapAnswer> => {
			const result = await answer(signedIn, options, state, method, args);
			if (result.isErr()) {
				return Err({kind: result.error.kind, message: callError(method, args, result.error)});
			}
			return Ok(JSON.stringify(result.value));
		},
		startedTask: () => state.started,
	};
}
