import type {Result} from 'ts-results-es';

import {type ApiError, Do, hasExperiment, parseSchema} from '@proxy/utils';
import {fillBodySchema, type Filled, type Picked, pickBodySchema} from '@proxy/contracts/intent';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {fillIntent, pickIntent, widgetsOffered} from './classify';

// The widgets the viewer is offered: New agent only in an organization that has Chat.
function offeredTo(viewer: OrgViewer) {
	return widgetsOffered(hasExperiment(viewer, 'harness'));
}

/** `POST /api/orgs/:org/intent` with `{text}` — which widget fits what the command bar is asked for, as it is typed. */
export function handlePickIntentRoute(request: AuthenticatedRequest): Promise<Result<Picked, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(pickBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		return $(await pickIntent(body.text, offeredTo(viewer)));
	});
}

/** `POST /api/orgs/:org/intent/fields` with `{text, widget}` — the fields of the widget picked for `text`, filled in. */
export function handleFillIntentRoute(request: AuthenticatedRequest): Promise<Result<Filled, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(fillBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		return $(await fillIntent(body.text, body.widget, offeredTo(viewer)));
	});
}
