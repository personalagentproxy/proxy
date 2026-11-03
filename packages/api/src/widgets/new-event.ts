import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {type MadeEvent, newEventBodySchema} from '@proxy/contracts/widgets';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {requireWritable} from './sources';
import {afterWrite} from './writes';

/**
 * The New event widget's Create: an event in the calendar picked, made as an agent's would be,
 * through the calendar's connector, so the guests get the provider's invitation.
 */

/** `POST /api/widgets/events`. */
export function handleCreateEventRoute(request: AuthenticatedRequest): Promise<Result<MadeEvent, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(newEventBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		const values = {title: body.title, start: body.start, end: body.end, location: body.location, guests: body.guests.join(', ')};
		const written = Object.keys(values).filter((key) => key !== 'guests' || body.guests.length > 0);
		const source = $(await requireWritable(viewer, body.connectionId, 'events', 'create', written));
		const create = $(requirePresent(source.connector.create, ApiErr.forbidden()));
		const made = $(await create(source, values, body.calendarId));
		await afterWrite({viewer, source, action: 'create', title: made.values.title ?? body.title, parent: body.calendarId});
		return {title: made.values.title ?? body.title, link: made.url ?? null};
	});
}
