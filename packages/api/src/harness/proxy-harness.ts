import type {HarnessBackend, HarnessEvent, HarnessTurn} from '@proxy/backends/harness/backend';
import {ApiErr, type ApiError, CHAT_MODELS, isChatModel} from '@proxy/utils';
import {compactionCut, type ContextEntry, toMessages, toTranscript} from '@proxy/utils/harness-context';

import type {askForTurn as askForTurnOverRouter, ModelTool} from '../llm/open-router';

/**
 * The harness this server has always run: one call to the model over OpenRouter per turn, on the
 * log as the chat completions form has it, with the api's tools; the calls the model makes are
 * left open for the api to run as jobs, which runs the harness again once every one is answered.
 * It keeps no session: every turn is built from the log, after the system prompt the api gave.
 * Its models are the few picked out of what OpenRouter has (CHAT_MODELS in @proxy/utils), each
 * with the hosts it may go to (llm/open-router.ts).
 * A log that has grown long is first summarized, by the same model, in a summary the api stores
 * and the model then reads in place of what it covers. The model gets the log to summarize as
 * text, not as the turns it made, which would need the tools sent along: a request with calls in
 * it and no tools is refused. A model that couldn't be reached is worth trying again; one that
 * refused the request, or turned the key down, is not.
 */

// How a long log is summarized, by the same model, for itself: a conversation's, or a
// sub-agent's, whose messages from the person are from the agent it works for.
const SUMMARIZE =
	'Summarize this conversation between a person and their agent, with the agent’s calls and their answers, so the agent can go on from the summary alone. Keep what the person asked for and wants; what was done and found, with names, ids, dates and numbers; what they were told; and what is still open or planned, such as after a sleep or a sub-agent’s answer, and which sub-agent ids are on what. Plain prose, from the agent’s side, no title.';
const SUMMARIZE_NOW = 'Write the summary now.';

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 120_000;

export const PROXY_HARNESS = 'proxy';

// The models it answers with: those picked out of what OpenRouter has (CHAT_MODELS), Claude first.
// Claude sees pictures, sent in the chat completions form as parts of what the person said; GLM
// is asked with words alone.
const MODELS: HarnessBackend['models'] = [
	{id: 'claude', label: CHAT_MODELS.claude, images: true},
	{id: 'glm', label: CHAT_MODELS.glm},
];

/** What the proxy harness runs on: the model over OpenRouter, with the server's key. */
export type ProxyHarnessDeps = {askForTurn: typeof askForTurnOverRouter; key: string};

// The tools as OpenRouter takes them.
function toModelTools(input: HarnessTurn): ModelTool[] {
	return input.tools.tools.map((tool) => ({name: tool.name, description: tool.description, parameters: tool.inputSchema}));
}

// The failure as the turn ends: a model out of reach is worth trying again, nothing else is.
function failed(error: ApiError): HarnessEvent {
	return {kind: 'failed', error, retry: error.kind === 'provider_unreachable'};
}

export function proxyHarness(deps: ProxyHarnessDeps): HarnessBackend {
	return {
		id: PROXY_HARNESS,
		label: 'OpenRouter',
		models: MODELS,
		turn: async function* (input) {
			if (input.signal.aborted) {
				yield failed(ApiErr.providerUnreachable(new Error('The turn was stopped before the model was asked')));
				return;
			}
			const {model} = input;
			if (!isChatModel(model)) {
				yield failed(ApiErr.unavailable(`The proxy harness has no model ${model}`));
				return;
			}
			const subAgents = input.subAgents ?? [];
			let entries: ContextEntry[] = input.entries;
			const cut = compactionCut(entries);
			const last = cut === null ? undefined : entries[cut - 1];
			if (cut !== null && last) {
				const summary = await deps.askForTurn({
					key: deps.key,
					model,
					messages: [
						{role: 'system', content: SUMMARIZE},
						{role: 'user', content: `${toTranscript(entries.slice(0, cut), subAgents)}\n\n${SUMMARIZE_NOW}`},
					],
					tools: [],
					maxTokens: MAX_TOKENS,
					timeoutMs: TIMEOUT_MS,
				});
				if (summary.isErr()) {
					yield failed(summary.error);
					return;
				}
				yield {kind: 'summary', text: summary.value.text, coversSeq: last.seq, inputTokens: summary.value.inputTokens, outputTokens: summary.value.outputTokens};
				// The log as the api has it once the summary is stored: the summary last, after every
				// entry, standing for those up to `coversSeq`.
				const stored: ContextEntry = {
					kind: 'summary',
					text: summary.value.text,
					toolCalls: null,
					callId: null,
					isError: false,
					direct: false,
					seq: (entries.at(-1)?.seq ?? 0) + 1,
					coversSeq: last.seq,
					inputTokens: null,
				};
				entries = [...entries, stored];
			}
			const turn = await deps.askForTurn({
				key: deps.key,
				model,
				messages: [{role: 'system', content: input.system}, ...toMessages(entries, subAgents, {clearOld: true})],
				tools: toModelTools(input),
				maxTokens: MAX_TOKENS,
				timeoutMs: TIMEOUT_MS,
			});
			if (turn.isErr()) {
				yield failed(turn.error);
				return;
			}
			if (turn.value.text !== '') {
				yield {kind: 'text', text: turn.value.text};
			}
			for (const call of turn.value.toolCalls) {
				yield {kind: 'tool_call', ...call};
			}
			yield {kind: 'done', session: input.session, system: input.system, inputTokens: turn.value.inputTokens, outputTokens: turn.value.outputTokens};
		},
	};
}
