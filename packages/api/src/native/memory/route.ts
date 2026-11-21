import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {MEMORY_INTEGRATION_ID} from '@proxy/integrations';
import type {memorySchema} from '@proxy/contracts/memory';

import {loadConnection} from '../../records/target';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireViewer} from '../../utils/user-org';
import {toMaker} from '../files/route';
import {isAbout, readNotes} from './notes';

/**
 * A member's memory as the person reads it, on its connection's page: every note, whole, with
 * the agents that wrote it. What they do to one, writing it, giving an earlier version back and
 * putting it in the trash, goes through the drive's routes (native/files/route.ts).
 */
export function handleMemoryRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof memorySchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connectionId = request.params.connectionId ?? '';
		const {connection, integration} = $(await loadConnection(viewer, connectionId));
		if (integration.id !== MEMORY_INTEGRATION_ID) {
			return $(Err(ApiErr.notFound('connection', connectionId)));
		}
		const notes = $(await readNotes(connection.id));
		return {
			notes: notes.map((note) => ({
				id: note.id,
				title: note.title,
				summary: note.summary,
				content: note.content,
				version: note.version,
				modifiedAt: note.modifiedAt.toISOString(),
				makers: note.makers.map(toMaker),
				about: isAbout(note.title),
			})),
		};
	});
}
