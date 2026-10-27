import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {AVATAR_COLORS, AVATAR_SHAPES, type ToolCall} from '@proxy/utils/harness';
import {deleteAgent} from '@proxy/db/agent';
import {
	appendPersonMessage,
	type ChatAgentRow,
	ensureMemberThread,
	type EntryRow,
	getChatAgent,
	getMemberThread,
	type LastMessage,
	listChatAgents,
	listEntries,
	listOpenJobs,
	listSubAgents,
	type ThreadRow,
	updateChatAgent,
} from '@proxy/db/harness';
import {AGENT_NAME_MAX, BUILT_IN_AGENT_PROVIDER} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {manages} from '../utils/manages';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {createBuiltInAgent} from './built-in-agent';

/**
 * The Chat page's routes, under the organization: its built-in agents, which every member sees,
 * each named and given a face, and the member's own conversation with each, its log, the
 * sub-agents started from it, and what they say in it. Behind the `harness` experiment. Nothing
 * here runs the model: a message queues a job, and the worker (worker.ts) does the rest; the page
 * reads the log again as it goes.
 */

const MAX_MESSAGE = 20_000;

/** A built-in agent as the page lists it: its persona, whether the viewer may change it, and the last thing said in their conversation with it, cut to a line; null before anything was said. */
export type ChatAgentResponse = {id: string; name: string; shape: string; color: string; mayChange: boolean; lastMessage: {kind: 'person' | 'assistant'; text: string; at: string} | null};

export type EntryResponse = {id: string; kind: 'person' | 'assistant' | 'tool_result' | 'event'; text: string; toolCalls: ToolCall[] | null; callId: string | null; isError: boolean; at: string};

/** A sub-agent started from the conversation: the call that started it, its title, the task its calls are made for, which the activity log can be narrowed to, and when it was done. */
export type SubAgentResponse = {callId: string; title: string; taskId: string; finishedAt: string | null};

/** The member's conversation with an agent: the agent, the thread, its log, the sub-agents started from it, and what the agent is up to: busy on it, asleep until a time, or waiting for the person. */
export type ThreadLogResponse = {agent: ChatAgentResponse; thread: {id: string}; entries: EntryResponse[]; subAgents: SubAgentResponse[]; busy: boolean; sleepingUntil: string | null};

// How much of the last message the list shows.
const PREVIEW_CHARS = 120;

// Whether the viewer may rename, reface or delete the agent: whoever made it, or the organization's owner (utils/manages.ts).
function managesAgent(viewer: OrgViewer, agent: ChatAgentRow): boolean {
	return manages(viewer, {ownerUserId: null, byId: agent.createdById});
}

function toAgent(viewer: OrgViewer, agent: ChatAgentRow & {lastMessage?: LastMessage | null}): ChatAgentResponse {
	const last = agent.lastMessage ?? null;
	return {
		id: agent.id,
		name: agent.name,
		shape: agent.shape,
		color: agent.color,
		mayChange: managesAgent(viewer, agent),
		lastMessage: last && {kind: last.kind, text: last.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS), at: last.createdAt.toISOString()},
	};
}

// An agent's persona as the person makes or changes it: a name, and a face from the catalog.
const personaSchema = z.object({
	name: z.string().trim().pipe(z.string().min(1).max(AGENT_NAME_MAX)),
	shape: z.enum(AVATAR_SHAPES),
	color: z.enum(AVATAR_COLORS),
});

// The entries the person sees: the conversation, not the summaries the model reads it as.
function isShown(entry: EntryRow): entry is EntryRow & {kind: EntryResponse['kind']} {
	return entry.kind !== 'summary';
}

function toEntry(entry: EntryRow & {kind: EntryResponse['kind']}): EntryResponse {
	return {id: entry.id, kind: entry.kind, text: entry.text, toolCalls: entry.toolCalls, callId: entry.callId, isError: entry.isError, at: entry.createdAt.toISOString()};
}

function requireChat(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (!hasExperiment(viewer, 'harness')) {
			return $(Err(ApiErr.forbidden()));
		}
		return viewer;
	});
}

// The agent in the address, one of the organization's built-in ones.
function requireAgent(viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<ChatAgentRow, ApiError>> {
	return Do(async ($) => {
		const agentId = request.params.agentId ?? '';
		return $(requirePresent($(await getChatAgent(viewer.orgId, agentId, BUILT_IN_AGENT_PROVIDER.id)), ApiErr.notFound('agent', agentId)));
	});
}

// The agent in the address, which the viewer may change; forbidden for one they only talk to.
function requireManagedAgent(viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<ChatAgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(viewer, request));
		if (!managesAgent(viewer, agent)) {
			return $(Err(ApiErr.forbidden()));
		}
		return agent;
	});
}

// The viewer's conversation with the agent, begun the first time.
function requireThread(viewer: OrgViewer, agent: ChatAgentRow): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		const existing = $(await getMemberThread(agent.id, viewer.userId));
		if (existing) {
			return existing;
		}
		return $(await ensureMemberThread({orgId: viewer.orgId, agentId: agent.id, userId: viewer.userId}));
	});
}

/** `GET /api/orgs/:org/chat/agents`: the organization's built-in agents, in the order they were made, with the viewer's conversations. */
export function handleListChatAgentsRoute(request: AuthenticatedRequest): Promise<Result<{agents: ChatAgentResponse[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const agents = $(await listChatAgents(viewer.orgId, viewer.userId, BUILT_IN_AGENT_PROVIDER.id));
		return {agents: agents.map((agent) => toAgent(viewer, agent))};
	});
}

/** `POST /api/orgs/:org/chat/agents` with `{name, shape, color}`: a new built-in agent, every member's. */
export function handleCreateChatAgentRoute(request: AuthenticatedRequest): Promise<Result<{agent: ChatAgentResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaSchema, request.body));
		const made = $(await createBuiltInAgent(viewer, persona));
		return {agent: toAgent(viewer, {...persona, id: made.id, createdById: made.createdById})};
	});
}

/** `PUT /api/orgs/:org/chat/agents/:agentId` with `{name, shape, color}`: the agent renamed, or with another face. */
export function handleUpdateChatAgentRoute(request: AuthenticatedRequest): Promise<Result<{agent: ChatAgentResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaSchema, request.body));
		const agent = $(await requireManagedAgent(viewer, request));
		if (!$(await updateChatAgent(viewer.orgId, agent.id, persona))) {
			return $(Err(ApiErr.notFound('agent', agent.id)));
		}
		return {agent: toAgent(viewer, {...agent, ...persona})};
	});
}

/** `DELETE /api/orgs/:org/chat/agents/:agentId`: the agent, with every member's conversation with it. */
export function handleDeleteChatAgentRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const agent = $(await requireManagedAgent(viewer, request));
		if (!$(await deleteAgent(viewer.orgId, agent.id))) {
			return $(Err(ApiErr.notFound('agent', agent.id)));
		}
	});
}

/** `GET /api/orgs/:org/chat/agents/:agentId/thread`: the viewer's conversation with the agent, begun where there was none, its sub-agents, and whether the agent is busy on it, sub-agents included. */
export function handleGetThreadRoute(request: AuthenticatedRequest): Promise<Result<ThreadLogResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const agent = $(await requireAgent(viewer, request));
		const thread = $(await requireThread(viewer, agent));
		const [entries, jobs, subAgents] = await Promise.all([listEntries(thread.id), listOpenJobs(thread.id), listSubAgents(thread.id)]);
		const open = $(jobs);
		const now = Date.now();
		// Asleep when every open job is a tool job due later; the first to be due is when it wakes.
		const later = open.filter((job) => job.runAt.getTime() > now);
		const asleep = open.length > 0 && later.length === open.length;
		const first = later.map((job) => job.runAt.getTime()).sort((a, b) => a - b)[0];
		return {
			agent: toAgent(viewer, agent),
			thread: {id: thread.id},
			entries: $(entries).filter(isShown).map(toEntry),
			subAgents: $(subAgents).map((sub) => ({callId: sub.parentCallId, title: sub.title, taskId: sub.taskId, finishedAt: sub.finishedAt?.toISOString() ?? null})),
			busy: open.length > 0 && !asleep,
			sleepingUntil: asleep && first !== undefined ? new Date(first).toISOString() : null,
		};
	});
}

const messageBodySchema = z.object({text: z.string().trim().min(1).max(MAX_MESSAGE)});

/** `POST /api/orgs/:org/chat/agents/:agentId/messages` with `{text}`: what the viewer says to the agent; the agent is woken. */
export function handlePostMessageRoute(request: AuthenticatedRequest): Promise<Result<{entry: EntryResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text} = $(parseSchema(messageBodySchema, request.body));
		const agent = $(await requireAgent(viewer, request));
		const thread = $(await requireThread(viewer, agent));
		const entry = $(requirePresent($(await appendPersonMessage(thread.id, text)), ApiErr.notFound('thread', thread.id)));
		return {entry: toEntry({...entry, kind: 'person'})};
	});
}
