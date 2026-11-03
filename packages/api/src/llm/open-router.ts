import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest, parseSchema} from '@proxy/utils';
import type {ToolCall} from '@proxy/utils/harness';

/**
 * The models this server asks over OpenRouter's chat completions, with the key in
 * `OPENROUTER_KEY`, each with a host policy of its own:
 *
 * - `askForJson`: gpt-oss-120b on Cerebras, the fastest host, else Groq, answering JSON held to a
 *   schema: the home page's model, which fills in a widget's fields and answers what Ask asks.
 * - `askForTurn`: the built-in agent's model, Claude Sonnet 5.5, answering a conversation with
 *   text, tool calls, or both. One call per turn; the loop (harness/inference.ts) runs the calls and
 *   asks again.
 *
 * What goes wrong is told apart alike for both: a model that can't be reached, or answered with
 * something that isn't an answer, is worth trying again; one that turned the server's key down, or
 * has no credit left, is not set up right; and one that refused the request was sent something
 * wrong, which no retry mends.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const JSON_MODEL = 'openai/gpt-oss-120b';

export const TURN_MODEL = 'anthropic/claude-sonnet-5.5';

// How much of what OpenRouter said went wrong is kept.
const MAX_SAID = 500;

/** A tool as the model is given it: its name, what it does, and the JSON Schema of its arguments. */
export type ModelTool = {name: string; description: string; parameters: object};

type ModelToolCall = {id: string; type: 'function'; function: {name: string; arguments: string}};

/** The conversation as the model reads it, in the chat completions form. */
export type ModelMessage =
	| {role: 'system'; content: string}
	| {role: 'user'; content: string}
	| {role: 'assistant'; content: string | null; tool_calls?: ModelToolCall[]}
	| {role: 'tool'; tool_call_id: string; content: string};

// Which hosts of the model OpenRouter may send the request to.
type ProviderPolicy = {order?: string[]; allow_fallbacks?: boolean; data_collection: 'deny'; zdr?: boolean};

// What is sent to OpenRouter.
type CompletionBody = {
	model: string;
	messages: ModelMessage[];
	max_tokens: number;
	provider: ProviderPolicy;
	tools?: Array<{type: 'function'; function: ModelTool}>;
	temperature?: number;
	reasoning?: {effort: 'low' | 'medium' | 'high'};
	response_format?: {type: 'json_schema'; json_schema: {name: string; strict: boolean; schema: object}};
};

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

type Completion = z.infer<typeof completionSchema>;

const errorBodySchema = z.object({error: z.object({message: z.string()})});

// What OpenRouter said went wrong, from the body of its answer.
function said(error: Extract<FetchError, {kind: 'http'}>): string {
	const parsed = errorBodySchema.safeParse(error.body);
	const message = parsed.success ? parsed.data.error.message : typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? '');
	return message.slice(0, MAX_SAID);
}

// The failure as this server's error, by what it means for the next try.
function toApiError(error: FetchError): ApiError {
	if (error.kind !== 'http') {
		return ApiErr.providerUnreachable(error);
	}
	if (error.status === 401 || error.status === 402 || error.status === 403) {
		return ApiErr.unavailable(`OpenRouter turned the server’s key down (${error.status}): ${said(error)}`);
	}
	if (error.status === 408 || error.status === 429 || error.status >= 500) {
		return ApiErr.providerUnreachable(error);
	}
	return ApiErr.internalError(new Error(`OpenRouter refused the request (${error.status}): ${said(error)}`));
}

// One chat completion from OpenRouter.
async function complete(key: string, body: CompletionBody, timeoutMs: number): Promise<Result<Completion, ApiError>> {
	const answered = await httpRequest(
		OPENROUTER_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/json', authorization: `Bearer ${key}`},
			body: JSON.stringify(body),
		},
		{schema: completionSchema, timeoutMs},
	);
	return answered.mapErr(toApiError);
}

export type JsonRequest<T> = {
	key: string;
	system: string;
	user: string;
	/** The JSON schema the answer is held to, and its name. */
	name: string;
	jsonSchema: object;
	/** The answer as it is read back. */
	answer: z.ZodType<T>;
	/** Its thinking and the answer count toward it: cut off, the answer would be no JSON at all. */
	maxTokens: number;
	timeoutMs: number;
};

/** What gpt-oss-120b answers to `system` and `user`, as JSON held to `jsonSchema`. */
export function askForJson<T>(request: JsonRequest<T>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const completion = $(
			await complete(
				request.key,
				{
					model: JSON_MODEL,
					messages: [
						{role: 'system', content: request.system},
						{role: 'user', content: request.user},
					],
					temperature: 0,
					max_tokens: request.maxTokens,
					// It thinks before answering; a little is enough here, and keeps it fast.
					reasoning: {effort: 'low'},
					response_format: {type: 'json_schema', json_schema: {name: request.name, strict: true, schema: request.jsonSchema}},
					// Cerebras first, Groq next, and any other host of the model after them, but only a
					// host OpenRouter records as keeping nothing, not even for a while to check for
					// abuse: the text is what the person typed, their bank's name or a merchant's among
					// it, or what their meetings and files say. With no such host, no answer at all.
					provider: {order: ['Cerebras', 'Groq'], allow_fallbacks: true, data_collection: 'deny', zdr: true},
				},
				request.timeoutMs,
			),
		);

		const content = completion.choices[0]?.message.content ?? '';
		const answer = Result.wrap((): unknown => JSON.parse(content)).andThen((json) => parseSchema(request.answer, json));
		if (answer.isErr()) {
			return $(Err(ApiErr.providerUnreachable(new Error(`The model answered outside the form: ${content.slice(0, 200)}`))));
		}
		return answer.value;
	});
}

export type TurnRequest = {
	key: string;
	messages: ModelMessage[];
	tools: ModelTool[];
	maxTokens: number;
	timeoutMs: number;
};

/** What the model answered: its text, the calls it made, and what the turn cost. */
export type ModelTurn = {text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number};

/** One turn of Claude Sonnet on the conversation. */
export function askForTurn(request: TurnRequest): Promise<Result<ModelTurn, ApiError>> {
	return Do(async ($) => {
		const completion = $(
			await complete(
				request.key,
				{
					model: TURN_MODEL,
					messages: request.messages,
					tools: request.tools.map((tool) => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}})),
					max_tokens: request.maxTokens,
					// Only a host that neither keeps prompts nor trains on them: the conversation is
					// the person's, and what their email and notes say is in it.
					provider: {data_collection: 'deny'},
				},
				request.timeoutMs,
			),
		);
		const {message} = completion.choices[0] ?? {};
		return {
			text: message?.content ?? '',
			toolCalls: (message?.tool_calls ?? []).map((call) => ({id: call.id, name: call.function.name, arguments: call.function.arguments})),
			inputTokens: completion.usage?.prompt_tokens ?? 0,
			outputTokens: completion.usage?.completion_tokens ?? 0,
		};
	});
}
