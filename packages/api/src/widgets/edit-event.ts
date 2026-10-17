import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import type {MadeEvent} from './new-event';
import {requireWritable} from './sources';
import {afterWrite} from './writes';

/**
 * The Change event widget's Save: an event already in a calendar, changed as an agent's edit
 * would be, through the calendar's connector, which sends only what is written differently and
 * tells the guests. Only an event the person organizes is changed here: one someone else invited
 * them to is theirs to answer, not to move.
 */

const bodySchema = z.object({
	connectionId: z.string().min(1),
	calendarId: z.string().min(1),
	eventId: z.string().min(1),
	title: z.string().trim().min(1).max(500).optional(),
	start: z.iso.datetime({offset: true}).optional(),
	end: z.iso.datetime({offset: true}).optional(),
	location: z.string().trim().max(500).optional(),
	// Everyone invited once it is changed, the account itself left out.
	guests: z.array(z.email()).max(100).optional(),
});

/** `PUT /api/widgets/events`. */
export function handleEditEventRoute(request: AuthenticatedRequest): Promise<Result<MadeEvent, ApiError>> {
	return Do(async ($) => {
		const {connectionId, calendarId, eventId, guests, ...rest} = $(parseSchema(bodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const changes = {...rest, ...(guests ? {guests: guests.join(', ')} : {})};
		const written = Object.keys(changes);
		const source = $(await requireWritable(orgId, connectionId, 'events', 'update', written));
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
			$(await requireWritable(orgId, connectionId, 'events', 'update', ['guests']));
		}
		const current = Object.fromEntries(source.collection.fields.filter((field) => !field.system).map((field) => [field.key, before.values[field.key] ?? '']));
		const changed = $(await source.connector.update(source, recordId, {...current, ...changes}, before));
		const title = changed.values.title ?? '';
		await afterWrite({orgId, userId: request.user.userId, source, action: 'update', title, parent: undefined});
		return {title, link: changed.url ?? null};
	});
}
