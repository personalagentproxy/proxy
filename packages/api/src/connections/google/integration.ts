import {availabilityConnector} from '../../records/google-availability';
import {contactsConnector} from '../../records/google-contacts';
import {gmailAttachmentsConnector, gmailConnector, gmailRepliesConnector} from '../../records/google-emails';
import {gmailLabelsConnector} from '../../records/google-labels';
import {eventsConnector} from '../../records/google-events';
import {filesConnector, runFilesCopy} from '../../records/google-files';
import {otherContactsConnector} from '../../records/google-other-contacts';
import {rangesConnector} from '../../records/google-ranges';
import {runFilesRestore, runFilesUndo, runFilesVersions} from '../../records/google-versions';
import {tasksConnector} from '../../records/google-tasks';
import type {ApiIntegration} from '../integration';
import {REVOKE_GOOGLE} from './revoke';
import {handleGoogleCallbackRoute, handleStartGoogleRoute} from './route';
import {unavailableGoogleConnectionActions} from './unavailable';

/**
 * A Google account, signed in to with the app's own Google client, fetched live from Google's APIs
 * with the connection's tokens, one collection or more per product, each described in its own file.
 * Copying a file in Drive is a tool of its own, since it names both the file and where the copy
 * goes, and so are a Drive file's versions, restoring one and undoing a change (google-versions.ts).
 * Its grant is revoked when its last connection goes, and a sign-in covers only the actions whose
 * scopes the person left ticked.
 */
export const GOOGLE_INTEGRATION: ApiIntegration = {
	id: 'google',
	connectors: {
		emails: gmailConnector,
		attachments: gmailAttachmentsConnector,
		replies: gmailRepliesConnector,
		labels: gmailLabelsConnector,
		events: eventsConnector,
		availability: availabilityConnector,
		files: filesConnector,
		ranges: rangesConnector,
		contacts: contactsConnector,
		otherContacts: otherContactsConnector,
		tasks: tasksConnector,
	},
	tools: {files_copy: runFilesCopy, files_versions: runFilesVersions, files_restore: runFilesRestore, files_undo: runFilesUndo},
	connect: {kind: 'signIn', name: 'Google', routes: () => ({handleStart: handleStartGoogleRoute, handleCallback: handleGoogleCallbackRoute})},
	revoke: REVOKE_GOOGLE,
	unavailableActions: unavailableGoogleConnectionActions,
};
