import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {eventChangeBodySchema, type MadeEvent} from '@proxy/contracts/widgets';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {requireWritable} from './sources';
import {afterWrite} from './writes';

/**
 * The Change event widget's Save: an event already in a calendar, changed as an agent's edit
 * would be, through the calendar's connector, which sends only what is written differently and
 * tells the guests. Only an event the person organizes is changed here: one someone else invited
 * them to is theirs to answer, not to move.
 */

/** `PUT /api/widgets/events`. */
export function handleEditEventRoute(request: AuthenticatedRequest): Promise<Result<MadeEvent, ApiError>> {
	return Do(async ($) => {
		const {connectionId, calendarId, eventId, guests, ...rest} = $(parseSchema(eventChangeBodySchema, request.body));
		const viewer = $(await requireViewer(request));
		const changes = {...rest, ...(guests ? {guests: guests.join(', ')} : {})};
		const written = Object.keys(changes);
		const source = $(await requireWritable(viewer, connectionId, 'events', 'update', written));
		const update = $(requirePresent(source.connector.update, ApiErr.forbidden()));
		const recordId = `${calendarId}:${eventId}`;
		const before = $(await source.connector.get(source, recordId));
		if (before.values.kind !== 'Event') {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		if ((before.values.organizer ?? '') !== '') {
			return $(Err(ApiErr.validationError('Only an event you organize can be changed here')));
		}
		// Changing an event with guests tells them, which needs Invite guests as writing them does.
		if (!written.includes('guests') && (before.values.guests ?? '') !== '') {
			$(await requireWritable(viewer, connectionId, 'events', 'update', ['guests']));
		}
		const current = Object.fromEntries(source.collection.fields.filter((field) => !field.system).map((field) => [field.key, before.values[field.key] ?? '']));
		const changed = $(await update(source, recordId, {...current, ...changes}, before));
		const title = changed.values.title ?? '';
		await afterWrite({viewer, source, action: 'update', title, parent: undefined});
		return {title, link: changed.url ?? null};
	});
}
