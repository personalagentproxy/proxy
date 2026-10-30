import type {FetchError} from '@proxy/utils';
import {redirect, type ShouldRevalidateFunctionArgs} from 'react-router';
import type {Result} from 'ts-results-es';
import {toolName} from '@proxy/integrations';
import {
	getAgentMe,
	getAgentTask,
	listAgentTasks,
	runAgentListTool,
	runAgentRecordTool,
} from '@/client/agent-client';
import type {DataRecord} from '@/lib/types';
import {isNotFoundError} from '@/client/request';
import {isTaskRefusal, taskRefusedPath} from '@/lib/agent-task';
import {unwrapLoaderResult} from '@/lib/loader-utils';

// The agent side's pages. Every records request is made for the task in the page's address,
// checked and logged by the api; a page shows what came back, a refusal included. A task the api
// refuses, unknown or finished, sends the agent back to its tasks.

// No live session, a revoked login included, sends the agent to its sign-in.
const AGENT_LOGIN = '/agent/login';

export type Outcome<T> = {kind: 'ok'; value: T} | {kind: 'denied'} | {kind: 'missing'};

// A run refused for its task, one finished since the page opened, sends the agent back to its
// tasks, rather than show the page as refused or missing.
function toOutcome<T>(taskId: string, result: Result<T, FetchError>): Outcome<T> {
	if (result.isErr() && isTaskRefusal(result.error)) {
		throw redirect(taskRefusedPath(taskId));
	}
	if (result.isErr() && result.error.kind === 'http' && result.error.status === 403) {
		return {kind: 'denied'};
	}
	if (result.isErr() && isNotFoundError(result.error)) {
		return {kind: 'missing'};
	}
	return {kind: 'ok', value: unwrapLoaderResult(result, AGENT_LOGIN)};
}

export async function agentSideLoader() {
	return unwrapLoaderResult(await getAgentMe(), AGENT_LOGIN);
}

// The task list: the agent's tasks under way, to open or finish.
export async function agentTasksLoader() {
	return unwrapLoaderResult(await listAgentTasks(), AGENT_LOGIN);
}

type Params = {taskId?: string; connectionId?: string; collectionId?: string; recordId?: string};

// A task's pages: the task, for the header to name, while it is under way.
export async function agentTaskLoader({params}: {params: Params}) {
	const taskId = params.taskId ?? '';
	const result = await getAgentTask(taskId);
	if (result.isErr() && isTaskRefusal(result.error)) {
		throw redirect(taskRefusedPath(taskId));
	}
	return unwrapLoaderResult(result, AGENT_LOGIN);
}

// The task is read again only when the address names another; its pages read the rest.
export function shouldRevalidateAgentTask({
	currentParams,
	nextParams,
}: ShouldRevalidateFunctionArgs) {
	return currentParams.taskId !== nextParams.taskId;
}

// The address's query is the list tool's params as they are: `?search=`, `?page=` and the
// collection's filter field, such as `?folder=Draft`. The api refuses any it doesn't take.
export async function agentCollectionLoader({params, request}: {params: Params; request: Request}) {
	const taskId = params.taskId ?? '';
	const query = Object.fromEntries(new URL(request.url).searchParams);
	return toOutcome(
		taskId,
		await runAgentListTool(
			taskId,
			params.connectionId ?? '',
			toolName(params.collectionId ?? '', 'list'),
			query,
		),
	);
}

export async function agentRecordLoader({params}: {params: Params}): Promise<Outcome<DataRecord>> {
	const taskId = params.taskId ?? '';
	const result = await runAgentRecordTool(
		taskId,
		params.connectionId ?? '',
		toolName(params.collectionId ?? '', 'view'),
		{id: params.recordId ?? ''},
	);
	const outcome = toOutcome(taskId, result);
	if (outcome.kind !== 'ok') {
		return outcome;
	}
	const {record} = outcome.value;
	if (!record) {
		return {kind: 'missing'};
	}
	return {kind: 'ok', value: record};
}
