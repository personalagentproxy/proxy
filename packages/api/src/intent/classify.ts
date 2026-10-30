import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type Experiment, httpRequest} from '@proxy/utils';

import {askForJson} from '../llm/open-router';
import {env} from '../utils/env';
import {INCOMPLETE, NO_WIDGET, offeredWidgets, type Widget, type WidgetField} from './widgets';

/**
 * What a person typed into the home page's input, in two steps, each a request of its own so the
 * home page shows the widget as soon as it is picked and fills it in when its fields come. First
 * Jev, TypeSafe AI's classifier, picks the widget that fits: one choice among the widgets offered,
 * `incomplete` and `none`. Then gpt-oss-120b, over OpenRouter on Cerebras, the fastest host, else
 * Groq, fills in that widget's fields from the text, held to a JSON schema of them alone. It fills
 * fields better than GLiNER did, every one right on nine in ten typed requests where GLiNER managed
 * half, since GLiNER found no title it wasn't told of, no subject and no file's name. The widgets
 * offered are the organization's: a widget behind an experiment it doesn't have is not among Jev's
 * choices, nor filled in.
 */

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

// Pinned, so a new release of Jev doesn't change which widget is picked until it is moved to.
const JEV_MODEL = 'jev-1.13.0';

// While typing goes on, a newer text is asked about every 300 ms, so a slower answer is never shown.
const TIMEOUT_MS = 5000;

const MAX_TOKENS = 2000;

/** A field of the picked widget and what fills it: one value, or each of a list's. */
export type FilledField = {id: string; name: string; values: string[]};

/** The widget Jev picked. */
export type Picked = {
	/** The widget's id, `none` when what was asked is whole and none does it, or `incomplete` when too little was typed to tell yet. */
	widget: string;
	/** How long Jev took. */
	ms: number;
};

/** The picked widget's fields, filled in. */
export type Filled = {
	fields: FilledField[];
	/** How long the model took. */
	ms: number;
};

// Jev's question: which of the widgets, `incomplete` or `none`, each described for it to tell apart.
function widgetQuestion(widgets: Widget[]) {
	return {
		type: 'choice',
		instructions: 'Which quick action is the person asking for in what they typed into a command box?',
		criteria: {
			...Object.fromEntries(widgets.map((widget) => [widget.id, widget.description])),
			[INCOMPLETE]:
				'The text is cut off or says too little to tell what is wanted yet, as it is while still being typed ("find the", "email", "what\'s"); never a whole sentence or question, which ends in a question mark or a full stop',
			[NO_WIDGET]: 'A whole request that none of the other actions does ("summarize my week", "what\'s the weather tomorrow")',
		},
	};
}

const pickSchema = z.object({answers: z.object({widget: z.object({choice: z.string()})})});

function instructions(widget: Widget): string {
	return [
		`Fill in the fields of the ${widget.name} widget (${widget.description}) from what the person typed into a command box. Copy values from the text, but write the body of an email; never invent a person, place or address. Answer with JSON only.`,
		'Fields:',
		...widget.fields.map((field) => `- ${field.id}${field.many ? ' (list)' : ''}: ${field.hint}`),
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

function jsonSchema(widget: Widget) {
	return {
		type: 'object',
		additionalProperties: false,
		required: widget.fields.map((field) => field.id),
		properties: Object.fromEntries(widget.fields.map((field) => [field.id, fieldSchema(field)])),
	};
}

// Each field's value by its id.
const answerSchema = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.array(z.array(z.string())), z.null()]));

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

// Which of `widgets` Jev picks for `text`: one of them, `incomplete` or `none`.
async function pickWidget(text: string, widgets: Widget[], key: string): Promise<Result<Widget | typeof INCOMPLETE | typeof NO_WIDGET, ApiError>> {
	const picked = await httpRequest(
		TYPESAFE_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/json', authorization: `Bearer ${key}`},
			body: JSON.stringify({model: JEV_MODEL, state: text, questions: {widget: widgetQuestion(widgets)}}),
		},
		{schema: pickSchema, timeoutMs: TIMEOUT_MS},
	);
	if (picked.isErr()) {
		return Err(ApiErr.providerUnreachable(picked.error));
	}

	const choice = picked.value.answers.widget.choice;
	if (choice === INCOMPLETE) {
		return Ok(INCOMPLETE);
	}
	return Ok(widgets.find((widget) => widget.id === choice) ?? NO_WIDGET);
}

// `widget`'s fields, as gpt-oss-120b fills them in from `text`.
function fillWidget(text: string, widget: Widget, key: string): Promise<Result<FilledField[], ApiError>> {
	return Do(async ($) => {
		const answer = $(
			await askForJson({
				key,
				system: instructions(widget),
				user: text,
				name: 'fields',
				jsonSchema: jsonSchema(widget),
				answer: answerSchema,
				// An email's body is among the fields, so it is well past what an answer takes.
				maxTokens: MAX_TOKENS,
				timeoutMs: TIMEOUT_MS,
			}),
		);
		return widget.fields.map((field) => ({id: field.id, name: field.name, values: cleaned(answer[field.id])}));
	});
}

// Both keys, as the home page needs Jev and the model that fills in alike.
function keys(): Result<{typesafe: string; openRouter: string}, ApiError> {
	if (!env.TYPESAFE_API_KEY || !env.OPENROUTER_KEY) {
		return Err(ApiErr.unavailable('The home page is not set up: set `TYPESAFE_API_KEY` and `OPENROUTER_KEY`.'));
	}
	return Ok({typesafe: env.TYPESAFE_API_KEY, openRouter: env.OPENROUTER_KEY});
}

/** Which of the widgets offered to `holder` fits `text`, as Jev picks it. */
export function pickIntent(text: string, holder: {experiments: Experiment[]}): Promise<Result<Picked, ApiError>> {
	return Do(async ($) => {
		const {typesafe} = $(keys());
		const start = performance.now();
		const picked = $(await pickWidget(text, offeredWidgets(holder), typesafe));
		return {widget: typeof picked === 'string' ? picked : picked.id, ms: Math.round(performance.now() - start)};
	});
}

/** The fields of `widgetId`, one of the widgets offered to `holder`, as gpt-oss-120b fills them in from `text`. */
export function fillIntent(text: string, widgetId: string, holder: {experiments: Experiment[]}): Promise<Result<Filled, ApiError>> {
	return Do(async ($) => {
		const {openRouter} = $(keys());
		const widget = offeredWidgets(holder).find((candidate) => candidate.id === widgetId);
		if (!widget) {
			return $(Err(ApiErr.notFound('widget', widgetId)));
		}

		const start = performance.now();
		const fields = $(await fillWidget(text, widget, openRouter));
		return {fields, ms: Math.round(performance.now() - start)};
	});
}
