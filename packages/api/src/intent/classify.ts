import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, httpRequest, parseSchema} from '@proxy/utils';

import {env} from '../utils/env';
import {INCOMPLETE, NO_WIDGET, WIDGETS, type WidgetField} from './widgets';

/**
 * What a person typed into the home page's input, in one request to gpt-oss-120b over OpenRouter,
 * on Cerebras, the fastest host, else Groq: the widget that fits, and its fields filled in from the
 * text, in about 150 ms. Picked over Jev and GLiNER, one after the other, by trying them on typed
 * requests: as fast, and every field right on nine in ten where GLiNER managed half, since it
 * found no title it wasn't told of, no subject and no file's name. The answer is held to a JSON
 * schema: the widget's id, and every widget's fields, the others left empty.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MODEL = 'openai/gpt-oss-120b';

// While typing goes on, a newer text is asked about every 300 ms, so a slower answer is never shown.
const TIMEOUT_MS = 5000;

/** A field of the picked widget and what fills it: one value, or each of a list's. */
export type FilledField = {id: string; name: string; values: string[]};

export type Intent = {
	/** The widget's id, `none` when what was asked is whole and none does it, or `incomplete` when too little was typed to tell yet. */
	widget: string;
	/** The widget's fields, each with what fills it; none for `none` and `incomplete`. */
	fields: FilledField[];
	/** How long the model took. */
	ms: number;
};

const FIELDS = WIDGETS.flatMap((widget) => widget.fields);

const INSTRUCTIONS = [
	'Pick the widget for what the person typed into a command box, and fill in its fields from the text. Copy values from the text, but write the body of an email; never invent a person, place or address. Leave the fields of other widgets empty. Answer with JSON only.',
	'Widgets:',
	...WIDGETS.map((widget) => `- ${widget.id}: ${widget.description}. Fields: ${widget.fields.map((field) => `${field.id}${field.many ? ' (list)' : ''}: ${field.hint}`).join('; ')}`),
	`- ${INCOMPLETE}: the text is cut off or says too little to tell what is wanted yet, as it is while still being typed ("find the", "email", "what's")`,
	`- ${NO_WIDGET}: a whole request that nothing above does ("summarize my week", "what's the weather tomorrow")`,
].join('\n');

function fieldSchema(field: WidgetField) {
	if (field.options) {
		return {type: ['string', 'null'], enum: [...field.options, null]};
	}
	if (field.terms) {
		return {type: 'array', items: {type: 'array', items: {type: 'string'}}};
	}
	if (field.many) {
		return {type: 'array', items: {type: 'string'}};
	}
	return {type: ['string', 'null']};
}

const JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['widget', ...FIELDS.map((field) => field.id)],
	properties: {
		widget: {type: 'string', enum: [...WIDGETS.map((widget) => widget.id), INCOMPLETE, NO_WIDGET]},
		...Object.fromEntries(FIELDS.map((field) => [field.id, fieldSchema(field)])),
	},
};

const completionSchema = z.object({choices: z.array(z.object({message: z.object({content: z.string()})})).min(1)});

// The widget's id, and each field's value by its id.
const answerSchema = z.object({widget: z.string()}).catchall(z.union([z.string(), z.array(z.string()), z.array(z.array(z.string())), z.null()]));

type AnswerValue = z.infer<typeof answerSchema>[string];

// Each value trimmed, once, and none empty.
function unique(values: string[]): string[] {
	return [...new Set(values.map((one) => one.trim()).filter((one) => one !== ''))];
}

// A field's values: its value, each of a list's, or each search term's words joined by " | ".
function cleaned(value: AnswerValue | undefined): string[] {
	if (value === null || value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		return unique([value]);
	}
	return unique(value.map((one) => (Array.isArray(one) ? unique(one.map((word) => word.replace(/\|/g, ' '))).join(' | ') : one)));
}

/** Which widget fits `text`, and its fields as the model fills them in. */
export async function classifyIntent(text: string): Promise<Result<Intent, ApiError>> {
	if (!env.OPENROUTER_KEY) {
		return Err(ApiErr.unavailable('The home page is not set up: set `OPENROUTER_KEY`.'));
	}

	const start = performance.now();
	const answered = await httpRequest(
		OPENROUTER_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/json', authorization: `Bearer ${env.OPENROUTER_KEY}`},
			body: JSON.stringify({
				model: MODEL,
				messages: [
					{role: 'system', content: INSTRUCTIONS},
					{role: 'user', content: text},
				],
				temperature: 0,
				max_tokens: 500,
				// It thinks before answering; a little is enough here, and keeps it fast.
				reasoning: {effort: 'low'},
				response_format: {type: 'json_schema', json_schema: {name: 'intent', strict: true, schema: JSON_SCHEMA}},
				provider: {order: ['Cerebras', 'Groq'], allow_fallbacks: true},
			}),
		},
		{schema: completionSchema, timeoutMs: TIMEOUT_MS},
	);
	const ms = Math.round(performance.now() - start);
	if (answered.isErr()) {
		return Err(ApiErr.providerUnreachable(answered.error));
	}

	const content = answered.value.choices[0]?.message.content ?? '';
	const answer = Result.wrap((): unknown => JSON.parse(content)).andThen((json) => parseSchema(answerSchema, json));
	if (answer.isErr()) {
		return Err(ApiErr.providerUnreachable(new Error(`The model answered outside the form: ${content.slice(0, 200)}`)));
	}

	if (answer.value.widget === INCOMPLETE) {
		return Ok({widget: INCOMPLETE, fields: [], ms});
	}
	const widget = WIDGETS.find((candidate) => candidate.id === answer.value.widget);
	if (!widget) {
		return Ok({widget: NO_WIDGET, fields: [], ms});
	}
	return Ok({widget: widget.id, fields: widget.fields.map((field) => ({id: field.id, name: field.name, values: cleaned(answer.value[field.id])})), ms});
}
