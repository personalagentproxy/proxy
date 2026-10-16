import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {requireWritable} from './sources';
import {afterWrite} from './writes';

/**
 * The New event widget's Create: an event in the calendar picked, made as an agent's would be,
 * through the calendar's connector, so the guests get the provider's invitation.
 */

const bodySchema = z.object({
	connectionId: z.string().min(1),
	calendarId: z.string().min(1),
	title: z.string().trim().min(1).max(500),
	start: z.iso.datetime({offset: true}),
	end: z.iso.datetime({offset: true}),
	location: z.string().trim().max(500).default(''),
	guests: z.array(z.email()).max(100).default([]),
});

export type MadeEvent = {title: string; link: string | null};

/** `POST /api/widgets/events`. */
export function handleCreateEventRoute(request: AuthenticatedRequest): Promise<Result<MadeEvent, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(bodySchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const values = {title: body.title, start: body.start, end: body.end, location: body.location, guests: body.guests.join(', ')};
		const written = Object.keys(values).filter((key) => key !== 'guests' || body.guests.length > 0);
		const source = $(await requireWritable(orgId, body.connectionId, 'events', 'create', written));
		const made = $(await source.connector.create(source, values, body.calendarId));
		await afterWrite({orgId, userId: request.user.userId, source, action: 'create', title: made.values.title ?? body.title, parent: body.calendarId});
		return {title: made.values.title ?? body.title, link: made.url ?? null};
	});
}
