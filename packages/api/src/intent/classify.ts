import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, type Experiment, httpRequest, parseSchema} from '@proxy/utils';

import {env} from '../utils/env';
import {INCOMPLETE, NO_WIDGET, offeredWidgets, type Widget, type WidgetField} from './widgets';

/**
 * What a person typed into the home page's input, in one request to gpt-oss-120b over OpenRouter,
 * on Cerebras, the fastest host, else Groq: the widget that fits, and its fields filled in from the
 * text, in about 150 ms. Picked over Jev and GLiNER, one after the other, by trying them on typed
 * requests: as fast, and every field right on nine in ten where GLiNER managed half, since it
 * found no title it wasn't told of, no subject and no file's name. The answer is held to a JSON
 * schema: the widget's id, and every widget's fields, the others left empty. The widgets offered
 * are the organization's: a widget behind an experiment it doesn't have is in neither the
 * instructions nor the schema.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MODEL = 'openai/gpt-oss-120b';

// While typing goes on, a newer text is asked about every 300 ms, so a slower answer is never shown.
const TIMEOUT_MS = 5000;

const MAX_TOKENS = 2000;

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

function instructions(widgets: Widget[]): string {
	return [
		'Pick the widget for what the person typed into a command box, and fill in its fields from the text. Copy values from the text, but write the body of an email; never invent a person, place or address. Leave the fields of other widgets empty. Answer with JSON only.',
		'Widgets:',
		...widgets.map((widget) => `- ${widget.id}: ${widget.description}. Fields: ${widget.fields.map((field) => `${field.id}${field.many ? ' (list)' : ''}: ${field.hint}`).join('; ')}`),
		`- ${INCOMPLETE}: the text is cut off or says too little to tell what is wanted yet, as it is while still being typed ("find the", "email", "what's"); never a whole sentence or question, which ends in a question mark or a full stop`,
		`- ${NO_WIDGET}: a whole request that nothing above does ("summarize my week", "what's the weather tomorrow")`,
	].join('\n');
}

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

function jsonSchema(widgets: Widget[]) {
	const fields = widgets.flatMap((widget) => widget.fields);
	return {
		type: 'object',
		additionalProperties: false,
		required: ['widget', ...fields.map((field) => field.id)],
		properties: {
			widget: {type: 'string', enum: [...widgets.map((widget) => widget.id), INCOMPLETE, NO_WIDGET]},
			...Object.fromEntries(fields.map((field) => [field.id, fieldSchema(field)])),
		},
	};
}

type Form = {widgets: Widget[]; instructions: string; schema: ReturnType<typeof jsonSchema>};

// The instructions and schema for each set of widgets offered, built once: there are few sets.
const forms = new Map<string, Form>();

function formFor(holder: {experiments: Experiment[]}): Form {
	const widgets = offeredWidgets(holder);
	const key = widgets.map((widget) => widget.id).join(' ');
	const kept = forms.get(key);
	if (kept) {
		return kept;
	}
	const form = {widgets, instructions: instructions(widgets), schema: jsonSchema(widgets)};
	forms.set(key, form);
	return form;
}

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

/** Which of the widgets offered to `holder` fits `text`, and its fields as the model fills them in. */
export async function classifyIntent(text: string, holder: {experiments: Experiment[]}): Promise<Result<Intent, ApiError>> {
	if (!env.OPENROUTER_KEY) {
		return Err(ApiErr.unavailable('The home page is not set up: set `OPENROUTER_KEY`.'));
	}

	const form = formFor(holder);
	const start = performance.now();
	const answered = await httpRequest(
		OPENROUTER_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/json', authorization: `Bearer ${env.OPENROUTER_KEY}`},
			body: JSON.stringify({
				model: MODEL,
				messages: [
					{role: 'system', content: form.instructions},
					{role: 'user', content: text},
				],
				temperature: 0,
				// Its thinking and every widget's fields count toward it, an email's body among them, so
				// it is well past what an answer takes: cut off, the answer would be no JSON at all.
				max_tokens: MAX_TOKENS,
				// It thinks before answering; a little is enough here, and keeps it fast.
				reasoning: {effort: 'low'},
				response_format: {type: 'json_schema', json_schema: {name: 'intent', strict: true, schema: form.schema}},
				// Cerebras first, Groq next, and any other host of the model after them, but only a
				// host OpenRouter records as neither keeping prompts nor training on them: the
				// text is what the person typed, their bank's name or a merchant's among it.
				provider: {order: ['Cerebras', 'Groq'], allow_fallbacks: true, data_collection: 'deny'},
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
	const widget = form.widgets.find((candidate) => candidate.id === answer.value.widget);
	if (!widget) {
		return Ok({widget: NO_WIDGET, fields: [], ms});
	}
	return Ok({widget: widget.id, fields: widget.fields.map((field) => ({id: field.id, name: field.name, values: cleaned(answer.value[field.id])})), ms});
}
