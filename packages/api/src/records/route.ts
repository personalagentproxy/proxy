import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {requiredAction} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {isRecordStore, type DataRecord, type RecordPage, type RecordStore, type RecordTarget} from './connector';
import {parseListQuery, requireListQuery, requireParent} from './list-query';
import {parseRecordValues} from './record-values';
import {loadRecordTarget} from './target';

// The human side's records: the owner of the connections reads and writes them in full, as far as
// the collection offers it, and nothing is logged. Agents go through the agent routes.

type Request = 'list' | 'view' | 'create' | 'update' | 'delete';

// The collection's records, where the collection offers what was `asked` of them; forbidden where it
// doesn't, as a collection that is only run, as a search is, offers no list.
function storeFor(request: AuthenticatedRequest, asked: Request): Promise<Result<RecordTarget & {connector: RecordStore}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const target = $(await loadRecordTarget(viewer, request.params.connectionId ?? '', request.params.collectionId ?? ''));
		const {connector} = target;
		if (requiredAction(target.collection, asked) === null || !isRecordStore(connector)) {
			return $(Err(ApiErr.forbidden()));
		}
		return {...target, connector};
	});
}

const writeBodySchema = z.object({values: z.unknown()});

// A new record, and in a nested collection the record it goes inside.
const createBodySchema = z.object({values: z.unknown(), parent: z.string().min(1).optional()});

/** A page of the collection's records, matching `?search=` and `?filter=` when given. */
export function handleListRecordsRoute(request: AuthenticatedRequest): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const query = $(parseListQuery(request.query));
		const target = $(await storeFor(request, 'list'));
		$(requireListQuery(target.collection, query));
		return $(await target.connector.list(target, query));
	});
}

export function handleGetRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await storeFor(request, 'view'));
		return $(await target.connector.get(target, request.params.recordId ?? ''));
	});
}

export function handleCreateRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await storeFor(request, 'create'));
		const create = $(requirePresent(target.connector.create, ApiErr.forbidden()));

		const {values, parent = null} = $(parseSchema(createBodySchema, request.body));
		$(requireParent(target.collection, parent));
		return $(await create(target, $(parseRecordValues(target.collection, values)), parent));
	});
}

export function handleUpdateRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await storeFor(request, 'update'));
		const update = $(requirePresent(target.connector.update, ApiErr.forbidden()));

		const {values} = $(parseSchema(writeBodySchema, request.body));
		return $(await update(target, request.params.recordId ?? '', $(parseRecordValues(target.collection, values))));
	});
}

export function handleDeleteRecordRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const target = $(await storeFor(request, 'delete'));
		const remove = $(requirePresent(target.connector.remove, ApiErr.forbidden()));

		$(await remove(target, request.params.recordId ?? ''));
	});
}
