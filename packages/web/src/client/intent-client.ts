import {z} from 'zod';
import {apiRequest} from '@/client/request';

// A widget's fields, each with what fills it: one value, or each of a list's.
const fieldsSchema = z.array(
	z.object({id: z.string(), name: z.string(), values: z.array(z.string())}),
);

const pickedSchema = z.object({
	// The widget's id, `none` when what was asked is whole and no widget does it, or `incomplete`
	// when too little was typed to tell yet.
	widget: z.string(),
	ms: z.number(),
});

const filledSchema = z.object({fields: fieldsSchema, ms: z.number()});

/** A widget and its fields, as the home page shows it. */
export type Intent = {widget: string; fields: z.infer<typeof fieldsSchema>};

/** Which widget fits what was typed (`POST /api/intent`). */
export function pickIntent(text: string) {
	return apiRequest('POST', '/api/intent', pickedSchema, {text});
}

/** The fields of the widget picked for what was typed, filled in (`POST /api/intent/fields`). */
export function fillIntent(text: string, widget: string) {
	return apiRequest('POST', '/api/intent/fields', filledSchema, {text, widget});
}
