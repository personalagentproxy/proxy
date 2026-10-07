import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {requiredAction} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import type {Connector, DataRecord, RecordPage, RecordTarget} from './connector';
import {parseListQuery, requireFilter} from './list-query';
import {parseRecordValues} from './record-values';
import {loadRecordTarget} from './target';

// The human side's records: the owner of the connections reads and writes them in full, as far as
// the collection offers it, and nothing is logged. Agents go through the agent routes.

function targetFor(request: AuthenticatedRequest): Promise<Result<RecordTarget & {connector: Connector}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		return $(await loadRecordTarget(orgId, request.params.connectionId ?? '', request.params.collectionId ?? ''));
	});
}

const writeBodySchema = z.object({values: z.unknown()});

/** A page of the collection's records, matching `?search=` and `?filter=` when given. */
export function handleListRecordsRoute(request: AuthenticatedRequest): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const query = $(parseListQuery(request.query));
		const target = $(await targetFor(request));
		$(requireFilter(target.collection, query.filter));
		return $(await target.connector.list(target, query));
	});
}

export function handleGetRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await targetFor(request));
		return $(await target.connector.get(target, request.params.recordId ?? ''));
	});
}

export function handleCreateRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await targetFor(request));
		if (requiredAction(target.collection, 'create') === null) {
			return $(Err(ApiErr.forbidden()));
		}

		const {values} = $(parseSchema(writeBodySchema, request.body));
		return $(await target.connector.create(target, $(parseRecordValues(target.collection, values))));
	});
}

export function handleUpdateRecordRoute(request: AuthenticatedRequest): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const target = $(await targetFor(request));
		if (requiredAction(target.collection, 'update') === null) {
			return $(Err(ApiErr.forbidden()));
		}

		const {values} = $(parseSchema(writeBodySchema, request.body));
		return $(await target.connector.update(target, request.params.recordId ?? '', $(parseRecordValues(target.collection, values))));
	});
}

export function handleDeleteRecordRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const target = $(await targetFor(request));
		if (requiredAction(target.collection, 'delete') === null) {
			return $(Err(ApiErr.forbidden()));
		}

		$(await target.connector.remove(target, request.params.recordId ?? ''));
	});
}
