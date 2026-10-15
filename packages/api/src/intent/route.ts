import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {classifyIntent, type Intent} from './classify';

const intentBodySchema = z.object({text: z.string().trim().min(1).max(500)});

/** `POST /api/intent` with `{text}` — what the home page's input asks for, as it is typed. */
export function handleClassifyIntentRoute(request: AuthenticatedRequest): Promise<Result<Intent, ApiError>> {
	return Do(async ($) => {
		const {text} = $(parseSchema(intentBodySchema, request.body));
		return $(await classifyIntent(text));
	});
}
