import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';
import type {Collection} from '@proxy/integrations';

export type RecordValues = Record<string, string>;

export type DataRecord = {id: string; values: RecordValues; updatedAt: string};

/** The connection and collection a request is about, with the connection's encrypted credential. */
export type RecordTarget = {
	connection: ConnectionRow & {credential: string | null};
	collection: Collection;
};

/**
 * How records of an integration are read and written. Callers have checked access and that the
 * collection can be written; a connector reports a missing record as not_found.
 */
export type Connector = {
	list: (target: RecordTarget) => Promise<Result<DataRecord[], ApiError>>;
	get: (target: RecordTarget, recordId: string) => Promise<Result<DataRecord, ApiError>>;
	create: (target: RecordTarget, values: RecordValues) => Promise<Result<DataRecord, ApiError>>;
	update: (target: RecordTarget, recordId: string, values: RecordValues) => Promise<Result<DataRecord, ApiError>>;
	remove: (target: RecordTarget, recordId: string) => Promise<Result<void, ApiError>>;
};
