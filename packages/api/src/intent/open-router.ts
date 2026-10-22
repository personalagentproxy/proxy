import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, httpRequest, parseSchema} from '@proxy/utils';

/**
 * gpt-oss-120b over OpenRouter, on Cerebras, the fastest host, else Groq, answering JSON held to a
 * schema: the home page's model, which fills in a widget's fields and answers what Ask asks.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MODEL = 'openai/gpt-oss-120b';

export type ModelRequest<T> = {
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

const completionSchema = z.object({choices: z.array(z.object({message: z.object({content: z.string()})})).min(1)});

/** What the model answers to `system` and `user`, as JSON held to `jsonSchema`. */
export function askModel<T>(request: ModelRequest<T>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const answered = await httpRequest(
			OPENROUTER_URL,
			{
				method: 'POST',
				headers: {'content-type': 'application/json', authorization: `Bearer ${request.key}`},
				body: JSON.stringify({
					model: MODEL,
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
				}),
			},
			{schema: completionSchema, timeoutMs: request.timeoutMs},
		);
		if (answered.isErr()) {
			return $(Err(ApiErr.providerUnreachable(answered.error)));
		}

		const content = answered.value.choices[0]?.message.content ?? '';
		const answer = Result.wrap((): unknown => JSON.parse(content)).andThen((json) => parseSchema(request.answer, json));
		if (answer.isErr()) {
			return $(Err(ApiErr.providerUnreachable(new Error(`The model answered outside the form: ${content.slice(0, 200)}`))));
		}
		return answer.value;
	});
}
