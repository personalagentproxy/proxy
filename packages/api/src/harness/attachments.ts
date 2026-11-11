import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {type EntryAttachment, type EntryImage, withAttachments} from '@proxy/utils/harness-context';
import type {ChatAttachment, postMessageBodySchema} from '@proxy/contracts/harness';
import type {AttachmentRow, DraftAttachment, EntryRow} from '@proxy/db/harness';
import type {z} from 'zod';

import type {PictureOf, PinnedIn} from '../backends/harness';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import type {OrgViewer} from '../utils/user-org';

/**
 * Files in a conversation: what the person attaches to what they say. A file attached is one of a
 * drive's (native/files), named by its connection, its id there and the version it held when it
 * was attached, which is what the conversation goes on meaning; the log keeps its name, kind and
 * size as they were, and the first of its text. A file put in a conversation's input is uploaded
 * at once and kept there, as what is typed is kept as the draft, so it is there on any device
 * until the message it goes with is sent. The person sees it with what they said; the model
 * reads what they said with each file under it (@proxy/utils/harness-context withAttachments),
 * whichever harness runs the turn, since the log is given to a harness with that already written
 * into what the person said; a model that sees pictures is given the pictures of the person's
 * last turns beside their words. The other way, the files the agent's answers show the person, as
 * pictures among its words, are kept with the answer the same way (inference.ts), and shown where
 * the answer puts them. Where the files come from is the drive's side (native/files/chat.ts),
 * given to the routes as `ChatFiles`, so the routes are tested without one.
 */

/** A file as the person names it to attach it. */
export type AttachmentRef = z.infer<typeof postMessageBodySchema>['attachments'][number];

export type ChatFiles = {
	/** A file uploaded from the conversation's input into the person's own drive, to be attached to what they say next: the request's body is the file. */
	upload: (viewer: OrgViewer, persona: {name: string}, request: AuthenticatedRequest) => Promise<Result<ChatAttachment, ApiError>>;
	/** The files named, each one the person can read, as the log keeps them; refused where one isn't. */
	resolve: (viewer: OrgViewer, refs: AttachmentRef[]) => Promise<Result<EntryAttachment[], ApiError>>;
	/** A file the log or the conversation's input keeps, as the page shows it. */
	shown: (attachment: DraftAttachment) => ChatAttachment;
	/** A file the log keeps as a picture for a model that sees pictures (`PictureOf`). */
	picture: PictureOf;
	/** The files an answer of the agent's shows the person, kept with it (`PinnedIn`). */
	pinned: PinnedIn;
};

/** How many of the person's turns back a picture is still shown to the model: the turn it is answering and the one before, as their words are kept as said (@proxy/utils/harness-context). */
const PICTURED_TURNS = 2;

/** A picture read for the model, with the file it is of. */
export type Picture = {of: AttachmentRow; image: EntryImage};

/**
 * The pictures among what the person attached that the model is to see with this turn: those of
 * their last turns, each read and made small enough by `picture`. One that isn't a picture, or
 * can't be read as one, is left out, and so is one the store no longer has: the model is then told
 * of the file and nothing more, as it is of any file that isn't text.
 */
export function picturesOf(entries: EntryRow[], attachments: AttachmentRow[], picture: PictureOf): Promise<Result<Picture[], ApiError>> {
	return Do(async ($) => {
		const turns = entries.filter((entry) => entry.kind === 'person').slice(-PICTURED_TURNS);
		const recent = attachments.filter((attachment) => turns.some((entry) => entry.id === attachment.entryId));
		const pictures: Picture[] = [];
		for (const of of recent) {
			const read = await picture(of);
			// Lost or unreadable is no reason to fail the turn; anything else is.
			const image = read.isErr() && read.error.kind === 'not_found' ? null : $(read);
			if (image !== null) {
				pictures.push({of, image});
			}
		}
		return pictures;
	});
}

/**
 * The log with what the person attached written into what they said, as the model reads it, and
 * the pictures among it given beside their words. What the agent's answers show the person is in
 * its words already, as it wrote them, and is told it no more.
 */
export function withAttached(entries: EntryRow[], attachments: AttachmentRow[], pictures: Picture[] = []): Array<EntryRow & {images?: EntryImage[]}> {
	if (attachments.length === 0) {
		return entries;
	}
	return entries.map((entry) => {
		// What the person said, and the note of what they wrote in a sub-agent's chat.
		const own = entry.kind === 'person' || entry.kind === 'note' ? attachments.filter((attachment) => attachment.entryId === entry.id) : [];
		if (own.length === 0) {
			return entry;
		}
		const shown = pictures.filter((picture) => own.includes(picture.of));
		const text = withAttachments(
			entry.text,
			own,
			shown.map((picture) => picture.of),
		);
		return shown.length === 0 ? {...entry, text} : {...entry, text, images: shown.map((picture) => picture.image)};
	});
}
