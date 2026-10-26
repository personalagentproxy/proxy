import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {CommandRunner, Connector, NewCommandRunner, RecordTarget} from './connector';
import {availabilityConnector} from './google-availability';
import {contactsConnector} from './google-contacts';
import {gmailConnector} from './google-emails';
import {eventsConnector} from './google-events';
import {createFilesRecord, getFilesRecord, listFilesTree, trashFilesRecord, updateFilesRecord} from './google-files';
import {otherContactsConnector} from './google-other-contacts';
import {rangesConnector} from './google-ranges';
import {tasksConnector} from './google-tasks';

/**
 * A Google account, fetched live from Google's APIs with the connection's tokens, one collection
 * per product: `emails`, Gmail (`google-emails.ts`), `events`, Calendar (`google-events.ts`),
 * `availability`, when people are busy (`google-availability.ts`), `files`, Drive with Docs,
 * Sheets and Slides (`google-files.ts`), `ranges`, a spreadsheet's values in A1 notation
 * (`google-ranges.ts`), `contacts`, Google Contacts (`google-contacts.ts`), `otherContacts`, the
 * people Gmail keeps under Other contacts (`google-other-contacts.ts`), and `tasks`, Google Tasks
 * (`google-tasks.ts`). Commands go to the collection they were run on, since two can share an id,
 * as Trash does.
 */

// Files are moved to Trash, never deleted: the collection offers no delete.
function notDeleted(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Files in Google Drive are moved to Trash, never deleted here')));
}

const filesConnector: Connector = {
	list: listFilesTree,
	get: getFilesRecord,
	create: createFilesRecord,
	update: updateFilesRecord,
	remove: notDeleted,
	commands: {trash: trashFilesRecord},
};

const COLLECTIONS: Partial<Record<string, Connector>> = {
	emails: gmailConnector,
	events: eventsConnector,
	availability: availabilityConnector,
	files: filesConnector,
	ranges: rangesConnector,
	contacts: contactsConnector,
	otherContacts: otherContactsConnector,
	tasks: tasksConnector,
};

function unknownCollection(target: RecordTarget): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.notFound('collection', target.collection.id)));
}

const unknownConnector: Connector = {list: unknownCollection, get: unknownCollection, create: unknownCollection, update: unknownCollection, remove: unknownCollection};

function connectorOf(target: RecordTarget): Connector {
	return COLLECTIONS[target.collection.id] ?? unknownConnector;
}

const connectors = Object.values(COLLECTIONS).flatMap((connector) => (connector ? [connector] : []));

function noCommand(id: string): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.notFound('command', id)));
}

// Every command id any collection has, each run by the collection's own.
const commands = Object.fromEntries(
	[...new Set(connectors.flatMap((connector) => Object.keys(connector.commands ?? {})))].map((id): [string, CommandRunner] => [
		id,
		(target, recordId) => connectorOf(target).commands?.[id]?.(target, recordId) ?? noCommand(id),
	]),
);

const newCommands = Object.fromEntries(
	[...new Set(connectors.flatMap((connector) => Object.keys(connector.newCommands ?? {})))].map((id): [string, NewCommandRunner] => [
		id,
		(target, values) => connectorOf(target).newCommands?.[id]?.(target, values) ?? noCommand(id),
	]),
);

export const googleConnector: Connector = {
	list: (target, query) => connectorOf(target).list(target, query),
	get: (target, recordId) => connectorOf(target).get(target, recordId),
	create: (target, values, parent) => connectorOf(target).create(target, values, parent),
	update: (target, recordId, values, before) => connectorOf(target).update(target, recordId, values, before),
	remove: (target, recordId) => connectorOf(target).remove(target, recordId),
	commands,
	newCommands,
};
