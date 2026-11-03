import type {Result} from 'ts-results-es';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {fillBodySchema, type Filled, type Picked, pickBodySchema} from '@proxy/contracts/intent';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {fillIntent, pickIntent} from './classify';

/** `POST /api/orgs/:org/intent` with `{text}` — which widget fits what the home page's input asks for, as it is typed. */
export function handlePickIntentRoute(request: AuthenticatedRequest): Promise<Result<Picked, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(pickBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		return $(await pickIntent(body.text, viewer));
	});
}

/** `POST /api/orgs/:org/intent/fields` with `{text, widget}` — the fields of the widget picked for `text`, filled in. */
export function handleFillIntentRoute(request: AuthenticatedRequest): Promise<Result<Filled, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(fillBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		return $(await fillIntent(body.text, body.widget, viewer));
	});
}
