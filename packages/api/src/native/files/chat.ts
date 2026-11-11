import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import type {EntryAttachment} from '@proxy/utils/harness-context';
import {FILES_INTEGRATION_ID} from '@proxy/integrations';
import {uploadAttachmentQuerySchema} from '@proxy/contracts/harness';
import {createFile, ensureFolder, type FileChangeBy, getFileVersion, getOwnDrive} from '@proxy/db/files';

import type {AttachmentRef, ChatFiles} from '../../harness/attachments';
import {loadConnection} from '../../records/target';
import type {OrgViewer} from '../../utils/user-org';
import {ensureFilesConnection} from './connections';
import {requireFile} from './connector';
import {maxFileBytes, readContent, storeContent, uploadBody} from './content';
import {isShownImage, mediaType, requireFileName} from './names';
import {PICTURE_SOURCE_BYTES, toPicture} from './picture';
import {readVersion} from './text';

/**
 * A conversation's files, on the drives' side (harness/attachments.ts ChatFiles). What the person
 * drops into a conversation is kept in their own drive, as any file of theirs is, in a folder of
 * the persona's under Chats, so it is there afterwards, with its versions, for them and their
 * agents alike. What they attach is named by where it is and the version it holds, read here as
 * the person, who may attach any file of a drive they use: the log keeps what it was, and the
 * first of its text for the model to read with the message. A picture is read for a model that
 * sees pictures as the turn is run (picture.ts); any other file that isn't text is attached all
 * the same, with nothing of it for the model.
 */

/** The folder at the top of a drive that the conversations' folders are in. */
const CHATS_FOLDER = 'Chats';

/** How much of one file's text goes with the message, and of all of a message's files together. */
const FILE_CHARACTERS = 8000;
const MESSAGE_CHARACTERS = 24_000;

const NO_DRIVE = 'Files aren’t set up here, so nothing can be attached.';

// The viewer's own drive, made where they have none yet.
function ownDrive(viewer: OrgViewer): Promise<Result<FileChangeBy, ApiError>> {
	return Do(async ($) => {
		$(await ensureFilesConnection(viewer));
		const found = $(await getOwnDrive({orgId: viewer.orgId, userId: viewer.userId, integrationId: FILES_INTEGRATION_ID}));
		const connectionId = $(requirePresent(found, ApiErr.unavailable(NO_DRIVE)));
		return {orgId: viewer.orgId, connectionId, by: {userId: viewer.userId}};
	});
}

// A persona's name as its folder's: as it is where it can be a folder's name.
function folderName(persona: {name: string}): string {
	return requireFileName(persona.name.replace(/[/\\]/g, ' ')).unwrapOr('Agent');
}

// One file named to attach, as the log keeps it, with as much of its text as `room` allows.
function resolveOne(viewer: OrgViewer, ref: AttachmentRef, room: number): Promise<Result<EntryAttachment, ApiError>> {
	return Do(async ($) => {
		const {connection, integration} = $(await loadConnection(viewer, ref.connectionId));
		if (integration.id !== FILES_INTEGRATION_ID) {
			return $(Err(ApiErr.notFound('connection', ref.connectionId)));
		}
		const file = $(await requireFile(connection.id, ref.fileId));
		if (file.folder) {
			return $(Err(ApiErr.validationError(`${file.name} is a folder: attach the files in it`)));
		}
		const version = $(requirePresent($(await getFileVersion(connection.id, file.id, ref.version)), ApiErr.notFound('version', ref.version)));
		const reading = $(await readVersion(file.name, version));
		const whole = 'text' in reading ? reading.text : null;
		const kept = Math.min(FILE_CHARACTERS, room);
		return {
			connectionId: connection.id,
			fileId: file.id,
			version: version.id,
			name: file.name,
			type: version.type,
			size: version.size,
			text: whole === null ? null : whole.slice(0, kept),
			cut: whole !== null && whole.length > kept,
		};
	});
}

export const chatFiles: ChatFiles = {
	upload: (viewer, persona, request) =>
		Do(async ($) => {
			const {name: raw, type} = $(parseSchema(uploadAttachmentQuerySchema, request.query));
			const name = $(requireFileName(raw));
			const change = $(await ownDrive(viewer));
			const chats = $(await ensureFolder(change, {parentId: null, name: CHATS_FOLDER}));
			const folder = $(await ensureFolder(change, {parentId: chats.id, name: folderName(persona)}));
			const stored = $(await storeContent(change.orgId, $(uploadBody(request)), maxFileBytes()));
			const content = {blobId: stored.blobId, size: stored.size, type: mediaType(name, type, 'bytes')};
			const made = $(await createFile(change, {parentId: folder.id, name, rename: true, content}));
			return {connectionId: change.connectionId, fileId: made.id, version: made.head?.id ?? '', name: made.name, type: content.type, size: content.size, shown: isShownImage(content.type)};
		}),
	resolve: (viewer, refs) =>
		Do(async ($) => {
			const attachments: EntryAttachment[] = [];
			let room = MESSAGE_CHARACTERS;
			for (const ref of refs) {
				const attachment = $(await resolveOne(viewer, ref, room));
				room -= attachment.text?.length ?? 0;
				attachments.push(attachment);
			}
			return attachments;
		}),
	shown: ({connectionId, fileId, version, name, type, size}) => ({connectionId, fileId, version, name, type, size, shown: isShownImage(type)}),
	// Read as the conversation's own, not as anyone's: the person attached it for the model to see.
	picture: (attachment) =>
		Do(async ($) => {
			if (!isShownImage(attachment.type) || attachment.size > PICTURE_SOURCE_BYTES) {
				return null;
			}
			const version = $(await getFileVersion(attachment.connectionId, attachment.fileId, attachment.version));
			if (version === null) {
				return null;
			}
			return toPicture(attachment.name, $(await readContent(version.blob)));
		}),
};
