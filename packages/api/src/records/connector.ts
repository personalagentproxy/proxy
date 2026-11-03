import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import type {Collection} from '@proxy/integrations';
import type {Crumb, DataRecord, RecordPage} from '@proxy/contracts/records';

import type {Capabilities} from './capabilities';

export type RecordValues = Record<string, string>;

// What the connectors read and write, as the api answers it (`@proxy/contracts/records`).
export type {Crumb, DataRecord, RecordPage};

/**
 * What to list: records matching `search`, with the collection's filter field at `filter` (an
 * email's folder), inside the record `parent` in a nested collection, from the page a previous
 * list pointed at.
 */
export type ListQuery = {search: string | null; page: string | null; filter: string | null; parent: string | null};

/**
 * A list that is all on one page, such as the vault's or a spreadsheet's tabs, gives no next page,
 * so a page asked of it is refused rather than its one page listed again.
 */
export function requireFirstPage(query: ListQuery): Result<void, ApiError> {
	if (query.page !== null) {
		return Err(ApiErr.validationError('That page is not one a list gave: this list is all on one page'));
	}
	return Ok(undefined);
}

/** The connection and collection a request is about, with the connection's encrypted credential. */
export type RecordTarget = {
	connection: ConnectionRow & {credential: string | null};
	collection: Collection;
};

/**
 * A command run on one record, such as archiving an email: the record as it is now, or null once it
 * has left the collection, as an archived email leaves the inbox.
 */
export type CommandRunner = (target: RecordTarget, recordId: string) => Promise<Result<DataRecord | null, ApiError>>;

/** A command on values typed in, such as sending a new email: the record it made, or null. */
export type NewCommandRunner = (target: RecordTarget, values: RecordValues) => Promise<Result<DataRecord | null, ApiError>>;

// By the catalog's command id: the record commands, and those on values typed in.
type CommandRunners = Partial<Record<string, CommandRunner>>;
type NewCommandRunners = Partial<Record<string, NewCommandRunner>>;

/**
 * How one collection's records are read and written. A collection offers only some writes and
 * commands, as the catalog says, and its connector has exactly those, as `connectors.test.ts`
 * checks; callers have checked access and that the collection offers the write or command. A
 * connector reports a missing record as not_found. It may have capabilities for the home page's
 * widgets too (`capabilities.ts`).
 */
export type RecordStore = Capabilities & {
	list: (target: RecordTarget, query: ListQuery) => Promise<Result<RecordPage, ApiError>>;
	get: (target: RecordTarget, recordId: string) => Promise<Result<DataRecord, ApiError>>;
	// In a nested collection, inside `parent` when one is given.
	create?: (target: RecordTarget, values: RecordValues, parent: string | null) => Promise<Result<DataRecord, ApiError>>;
	// `before` is the record as the caller read it, for a connector to tell what was written
	// differently from it without reading it again.
	update?: (target: RecordTarget, recordId: string, values: RecordValues, before?: DataRecord) => Promise<Result<DataRecord, ApiError>>;
	remove?: (target: RecordTarget, recordId: string) => Promise<Result<void, ApiError>>;
	commands?: CommandRunners;
	newCommands?: NewCommandRunners;
};

/**
 * A collection whose records are only run, never listed, opened or kept, as a search is: the
 * catalog gives it no read, and its commands are all on values typed in.
 */
export type RunOnly = {newCommands: NewCommandRunners};

export type Connector = RecordStore | RunOnly;

export function isRecordStore(connector: Connector): connector is RecordStore {
	return 'list' in connector;
}
