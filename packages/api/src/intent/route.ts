import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {type Filled, fillIntent, type Picked, pickIntent} from './classify';

const text = z.string().trim().min(1).max(500);

const pickBodySchema = z.object({text});

const fillBodySchema = z.object({text, widget: z.string().min(1)});

/** `POST /api/intent` with `{text}` — which widget fits what the home page's input asks for, as it is typed. */
export function handlePickIntentRoute(request: AuthenticatedRequest): Promise<Result<Picked, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(pickBodySchema, request.body));
		return $(await pickIntent(body.text, request.user));
	});
}

/** `POST /api/intent/fields` with `{text, widget}` — the fields of the widget picked for `text`, filled in. */
export function handleFillIntentRoute(request: AuthenticatedRequest): Promise<Result<Filled, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(fillBodySchema, request.body));
		return $(await fillIntent(body.text, body.widget, request.user));
	});
}
