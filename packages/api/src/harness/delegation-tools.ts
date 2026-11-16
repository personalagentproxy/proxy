import {z} from 'zod';
import {Do, type ApiError, requirePresent} from '@proxy/utils';
import {callArguments, type ToolCall} from '@proxy/utils/harness';
import type {InlineJob, ThreadRow} from '@proxy/db/harness';
import type {ToolAnswer} from '@proxy/backends/harness/backend';
import type {Result} from 'ts-results-es';
import type {ModelTool} from '../llm/open-router';
import type {HarnessStore} from './store';
import {jobLost} from './thread-rules';

export const DELEGATION_TOOLS: ModelTool[] = [
	{
		name: 'list_agents',
		description: 'List the specialist agents available to this conversation. Use their IDs to delegate explicit tasks. No other agent history is shared.',
		parameters: {type: 'object', properties: {}, additionalProperties: false},
	},
	{
		name: 'delegate_to_agent',
		description:
			'Start an asynchronous task with a specialist. Pass only necessary context. Returns a delegation ID; the result will arrive as an event here and wake you automatically. Up to 8 tasks per root conversation task and 3 levels; cycles are refused. Do not claim completion until the result arrives.',
		parameters: {
			type: 'object',
			properties: {agentId: {type: 'string'}, task: {type: 'string', description: 'A self-contained task and relevant context, at most 12000 characters.'}},
			required: ['agentId', 'task'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_delegations',
		description: 'Read this thread’s delegated tasks, their status and results. Other conversations are not included.',
		parameters: {type: 'object', properties: {}, additionalProperties: false},
	},
	{
		name: 'cancel_delegation',
		description: 'Cancel one of this thread’s running delegations and its descendants. Already completed external actions cannot be undone.',
		parameters: {type: 'object', properties: {id: {type: 'string'}}, required: ['id'], additionalProperties: false},
	},
];

export type DelegationToolStore = Pick<HarnessStore, 'listDelegateAgents' | 'delegateToAgent' | 'listDelegations' | 'cancelDelegation'>;
export function isDelegationTool(name: string): boolean {
	return DELEGATION_TOOLS.some((tool) => tool.name === name);
}
const taskSchema = z.object({agentId: z.string().min(1), task: z.string().trim().min(1).max(12000)}).strict();
const cancelSchema = z.object({id: z.string().min(1)}).strict();

export function runDelegationTool(store: DelegationToolStore, thread: ThreadRow, job: InlineJob, call: ToolCall): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === 'list_agents') {
			return {text: JSON.stringify($(await store.listDelegateAgents(thread))), isError: false};
		}
		if (call.name === 'list_delegations') {
			const rows = $(await store.listDelegations(thread.id));
			return {text: JSON.stringify(rows.map((row) => ({id: row.id, agent: row.targetName, task: row.task, status: row.status, result: row.result}))), isError: false};
		}
		if (call.name === 'cancel_delegation') {
			const parsed = cancelSchema.safeParse(callArguments(call));
			if (!parsed.success) {
				return {text: 'Give the delegation id.', isError: true};
			}
			const cancelled = $(requirePresent($(await store.cancelDelegation(job, parsed.data.id)), jobLost()));
			return {text: cancelled ? 'Delegation cancelled.' : 'No running delegation with that ID in this thread.', isError: !cancelled};
		}
		const parsed = taskSchema.safeParse(callArguments(call));
		if (!parsed.success) {
			return {text: 'Give an agentId and a task of 1–12000 characters.', isError: true};
		}
		const result = $(requirePresent($(await store.delegateToAgent(job, `${job.jobId}:${call.id}`, parsed.data.agentId, parsed.data.task)), jobLost()));
		if ('error' in result) {
			return {text: result.error, isError: true};
		}
		return {
			text: JSON.stringify({id: result.delegation.id, agent: result.delegation.targetName, status: result.delegation.status, message: 'The result will be delivered here automatically.'}),
			isError: false,
		};
	});
}
