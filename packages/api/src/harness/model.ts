import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, httpRequest} from '@proxy/utils';
import type {ToolCall} from '@proxy/utils/harness';

/**
 * The built-in agent's model: Claude Sonnet 5.5 over OpenRouter, answering a conversation with
 * text, tool calls, or both, in the chat completions form. One call per turn; the loop
 * (inference.ts) runs the calls and asks again.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const MODEL = 'anthropic/claude-sonnet-5.5';

/** A tool as the model is given it: its name, what it does, and the JSON Schema of its arguments. */
export type ModelTool = {name: string; description: string; parameters: object};

/** The conversation as the model reads it, in the chat completions form. */
export type ModelMessage =
	| {role: 'system'; content: string}
	| {role: 'user'; content: string}
	| {role: 'assistant'; content: string | null; tool_calls?: Array<{id: string; type: 'function'; function: {name: string; arguments: string}}>}
	| {role: 'tool'; tool_call_id: string; content: string};

export type ModelRequest = {
	key: string;
	messages: ModelMessage[];
	tools: ModelTool[];
	maxTokens: number;
	timeoutMs: number;
};

/** What the model answered: its text, the calls it made, and what the turn cost. */
export type ModelTurn = {text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number};

const completionSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable().optional(),
					tool_calls: z.array(z.object({id: z.string(), function: z.object({name: z.string(), arguments: z.string()})})).optional(),
				}),
			}),
		)
		.min(1),
	usage: z.object({prompt_tokens: z.number(), completion_tokens: z.number()}).optional(),
});

/** One turn of the model on the conversation. */
export function askModel(request: ModelRequest): Promise<Result<ModelTurn, ApiError>> {
	return Do(async ($) => {
		const answered = await httpRequest(
			OPENROUTER_URL,
			{
				method: 'POST',
				headers: {'content-type': 'application/json', authorization: `Bearer ${request.key}`},
				body: JSON.stringify({
					model: MODEL,
					messages: request.messages,
					tools: request.tools.map((tool) => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}})),
					max_tokens: request.maxTokens,
					// Only a host that neither keeps prompts nor trains on them: the conversation is
					// the person's, and what their email and notes say is in it.
					provider: {data_collection: 'deny'},
				}),
			},
			{schema: completionSchema, timeoutMs: request.timeoutMs},
		);
		if (answered.isErr()) {
			return $(Err(ApiErr.providerUnreachable(answered.error)));
		}
		const {message} = answered.value.choices[0] ?? {};
		return {
			text: message?.content ?? '',
			toolCalls: (message?.tool_calls ?? []).map((call) => ({id: call.id, name: call.function.name, arguments: call.function.arguments})),
			inputTokens: answered.value.usage?.prompt_tokens ?? 0,
			outputTokens: answered.value.usage?.completion_tokens ?? 0,
		};
	});
}
