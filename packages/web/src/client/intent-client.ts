import {z} from 'zod';
import {apiRequest} from '@/client/request';

const intentSchema = z.object({
	// The widget's id, `none` when what was asked is whole and no widget does it, or `incomplete`
	// when too little was typed to tell yet.
	widget: z.string(),
	// Its fields, each with what fills it: one value, or each of a list's.
	fields: z.array(z.object({id: z.string(), name: z.string(), values: z.array(z.string())})),
	ms: z.number(),
});

export type Intent = z.infer<typeof intentSchema>;

/** Which widget fits what was typed, and its fields filled in (`POST /api/intent`). */
export function classifyIntent(text: string) {
	return apiRequest('POST', '/api/intent', intentSchema, {text});
}
