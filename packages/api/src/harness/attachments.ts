import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {type EntryAttachment, withAttachments} from '@proxy/utils/harness-context';
import type {ChatAttachment, postMessageBodySchema} from '@proxy/contracts/harness';
import type {AttachmentRow, EntryRow} from '@proxy/db/harness';
import type {z} from 'zod';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import type {OrgViewer} from '../utils/user-org';

/**
 * Files in a conversation: what the person attaches to what they say. A file attached is one of a
 * drive's (native/files), named by its connection, its id there and the version it held when it
 * was attached, which is what the conversation goes on meaning; the log keeps its name, kind and
 * size as they were, and the first of its text. The person sees it with what they said; the model
 * reads what they said with each file under it (@proxy/utils/harness-context withAttachments),
 * whichever harness runs the turn, since the log is given to a harness with that already written
 * into what the person said. Where the files come from is the drive's side (native/files/chat.ts),
 * given to the routes as `ChatFiles`, so the routes are tested without one.
 */

/** A file as the person names it to attach it. */
export type AttachmentRef = z.infer<typeof postMessageBodySchema>['attachments'][number];

export type ChatFiles = {
	/** A file uploaded from the conversation's input into the person's own drive, to be attached to what they say next: the request's body is the file. */
	upload: (viewer: OrgViewer, persona: {name: string}, request: AuthenticatedRequest) => Promise<Result<ChatAttachment, ApiError>>;
	/** The files named, each one the person can read, as the log keeps them; refused where one isn't. */
	resolve: (viewer: OrgViewer, refs: AttachmentRef[]) => Promise<Result<EntryAttachment[], ApiError>>;
	/** A file the log keeps, as the page shows it. */
	shown: (attachment: EntryAttachment) => ChatAttachment;
};

/** The log with what the person attached written into what they said, as the model reads it. */
export function withAttached(entries: EntryRow[], attachments: AttachmentRow[]): EntryRow[] {
	if (attachments.length === 0) {
		return entries;
	}
	return entries.map((entry) => {
		const own = attachments.filter((attachment) => attachment.entryId === entry.id);
		return own.length === 0 ? entry : {...entry, text: withAttachments(entry.text, own)};
	});
}
