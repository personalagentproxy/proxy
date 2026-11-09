import {Err, Ok, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import type {ToolCall} from '@proxy/utils/harness';
import type {AlertRow, NewAlert} from '@proxy/db/alerts';
import type {ThreadRow} from '@proxy/db/harness';

import {callMcpTool} from '../mcp/tools';
import {alertArgs, type AlertSpec, CANCEL_ALERT_TOOL, describeAlert, WATCHED_COLLECTIONS} from './alerts';
import type {HarnessStore} from './store';
import {ensureThreadTask, type ThreadTaskStore} from './thread-task';
import {watchableConnections} from './watch-connections';

/**
 * What a call the model made is answered with, by its tool: the part shared by the two ways a call
 * is run, as a job of the api's once the turn is written (tool-job.ts), and inline, mid-turn, by a
 * harness that runs its tools itself (tool-surface.ts). A sub-agent's calls to the MCP server's
 * tools go through the gate as the sub-agent acting as the member, for its task, logged like any
 * agent's call, the result cut to what the log keeps. The agent talking with the person's alert
 * calls: a cancel is done here, and a set is checked, the alert it is to set given back rather than
 * set, since setting it is a write the two ways fence differently. And the words both ways answer
 * with: for arguments that aren't a JSON object, a tool the thread hasn't got, a sleep without a
 * time, and a call a worker was interrupted in, whose outcome is unknown for a write and which is
 * simply not answered for anything else.
 */

/** What answering a call needs of the store: the agent as it acts in the thread, the sub-agent's task, and the alerts to cancel. */
export type ToolAnswerStore = Pick<HarnessStore, 'getThreadAgent' | 'deleteAlert'> & ThreadTaskStore;

export type ToolAnswer = {text: string; isError: boolean};

/** What an alert call comes to: its answer, or, for a set_alert call, the alert to set, answered as it is set. */
export type AlertCallOutcome = ToolAnswer | {alert: NewAlert};

export const NOT_JSON = 'The arguments were not a JSON object.';
export const BAD_SLEEP_ARGS = 'Give until, a time in ISO 8601, or seconds from now.';
/** What a `run` call a worker was interrupted in is answered with: the write may have gone through. */
export const RUN_INTERRUPTED = 'The outcome of this call is unknown: the worker running it was interrupted before it could record the answer. Check what it changed before making it again.';
/** What any other call a worker was interrupted in is answered with. */
export const CALL_INTERRUPTED = 'This call was interrupted before it was answered.';

// How much of a result the log keeps, and the model reads.
const MAX_RESULT_CHARS = 60_000;

export function error(text: string): ToolAnswer {
	return {text, isError: true};
}

/** What a call to a tool the thread's agent hasn't got is answered with. */
export function noSuchTool(name: string): ToolAnswer {
	return error(`There is no tool ${name}.`);
}

// A result cut to what the log keeps, saying so at its end, so the model knows there was more.
function cutResult(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut: the result was ${text.length} characters long.]`;
}

/** Runs the call through the gate, as the sub-agent acts in the thread, for its task. */
export function runGateTool(store: ToolAnswerStore, thread: ThreadRow, name: string, args: Record<string, unknown>): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(requirePresent($(await store.getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const taskId = $(await ensureThreadTask(store, thread));
		const result = await callMcpTool(signedIn, name, {...args, task: taskId}, false, 'harness');
		return {text: cutResult(result.content.map((part) => part.text).join('\n')), isError: result.isError === true};
	});
}

// The alert a set_alert call sets: a timed one as given; a watch on the connections the agent may
// watch for the collection, those named where they are, which is what the model is told where it
// may not.
function alertToSet(store: ToolAnswerStore, thread: ThreadRow, spec: AlertSpec): Promise<Result<Result<NewAlert, string>, ApiError>> {
	return Do(async ($) => {
		if (spec.kind === 'time') {
			return Ok(spec);
		}
		const signedIn = $(requirePresent($(await store.getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const watchable = $(await watchableConnections(signedIn, spec.collectionId));
		const name = WATCHED_COLLECTIONS[spec.collectionId];
		if (watchable.length === 0) {
			return Err(`No connection you may read has ${name}: the person has to connect one, or give you access to it.`);
		}
		const unknown = (spec.connectionIds ?? []).filter((id) => !watchable.some((connection) => connection.id === id));
		if (unknown.length > 0) {
			return Err(`You may not watch ${unknown.join(', ')} for ${name}. The connections you may watch for it: ${watchable.map((connection) => `${connection.id} (${connection.name})`).join(', ')}.`);
		}
		return Ok({...spec, connectionIds: spec.connectionIds ?? watchable.map((connection) => connection.id)});
	});
}

/** How a set_alert call is answered, with the alert it set. */
export function setText(alert: AlertRow): string {
	return `Set the alert ${describeAlert(alert)}. The person sees it on their Alerts page.`;
}

/** The main agent's alert calls: a cancel answered, or the alert to set. */
export function alertCall(store: ToolAnswerStore, thread: ThreadRow, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<AlertCallOutcome, ApiError>> {
	return Do(async ($) => {
		if (call.name === CANCEL_ALERT_TOOL) {
			const id = typeof args.id === 'string' ? args.id : '';
			if (!$(await store.deleteAlert(id, {threadId: thread.id}))) {
				return error(`There is no alert ${id} in this conversation. Your instructions list the alerts set in it, by id.`);
			}
			return {text: `Cancelled the alert ${id}.`, isError: false};
		}
		const spec = alertArgs(args, now);
		if (spec.isErr()) {
			return error(spec.error);
		}
		const alert = $(await alertToSet(store, thread, spec.value));
		if (alert.isErr()) {
			return error(alert.error);
		}
		return {alert: alert.value};
	});
}
