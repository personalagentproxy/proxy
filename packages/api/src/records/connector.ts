import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import type {Collection} from '@proxy/integrations';

export type RecordValues = Record<string, string>;

/** A record and, in a nested collection, whether it holds records of its own to list. */
export type DataRecord = {id: string; values: RecordValues; updatedAt: string; hasChildren?: boolean};

/**
 * What to list: records matching `search`, with the collection's filter field at `filter` (an
 * email's folder), inside the record `parent` in a nested collection, from the page a previous
 * list pointed at.
 */
export type ListQuery = {search: string | null; page: string | null; filter: string | null; parent: string | null};

/** A record a list was opened in, or one above it. */
export type Crumb = {id: string; title: string};

/**
 * One page of records, newest first, and the token of the next, older page if there is one. A
 * list opened in a record says where it is: that record last, those above it before it.
 */
export type RecordPage = {records: DataRecord[]; nextPage: string | null; trail?: Crumb[]};

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

/**
 * How records of an integration are read and written. Callers have checked access and that the
 * collection offers the write or command; a connector reports a missing record as not_found.
 */
export type Connector = {
	list: (target: RecordTarget, query: ListQuery) => Promise<Result<RecordPage, ApiError>>;
	get: (target: RecordTarget, recordId: string) => Promise<Result<DataRecord, ApiError>>;
	// In a nested collection, inside `parent` when one is given.
	create: (target: RecordTarget, values: RecordValues, parent: string | null) => Promise<Result<DataRecord, ApiError>>;
	update: (target: RecordTarget, recordId: string, values: RecordValues) => Promise<Result<DataRecord, ApiError>>;
	remove: (target: RecordTarget, recordId: string) => Promise<Result<void, ApiError>>;
	// By the catalog's command id: the record commands, and those on values typed in.
	commands?: Partial<Record<string, CommandRunner>>;
	newCommands?: Partial<Record<string, NewCommandRunner>>;
};
