import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import type {Collection} from '@proxy/integrations';

import type {ListQuery} from './connector';

const listQuerySchema = z.object({
	search: z.string().trim().max(200).optional(),
	page: z.string().min(1).optional(),
	filter: z.string().min(1).optional(),
	parent: z.string().min(1).optional(),
});

/** `?search=…&page=…&filter=…&parent=…` from a list request; an empty search lists everything. */
export function parseListQuery(query: unknown): Result<ListQuery, ApiError> {
	return parseSchema(listQuerySchema, query).map(({search, page, filter, parent}) => ({search: search || null, page: page ?? null, filter: filter ?? null, parent: parent ?? null}));
}

/** A record only goes inside another in a nested collection. */
export function requireParent(collection: Collection, parent: string | null): Result<void, ApiError> {
	if (parent !== null && !collection.nested) {
		return Err(ApiErr.validationError(`${collection.name} don't go inside one another`));
	}
	return Ok(undefined);
}

/**
 * A filter must be one of the values of the collection's filter field, such as an email's folder,
 * a search needs a collection that can be searched, and a parent a nested one.
 */
export function requireListQuery(collection: Collection, query: ListQuery): Result<void, ApiError> {
	if (query.search !== null && !collection.searchHint) {
		return Err(ApiErr.validationError(`${collection.name} can't be searched`));
	}
	const parent = requireParent(collection, query.parent);
	if (parent.isErr()) {
		return parent;
	}
	const field = collection.fields.find((candidate) => candidate.key === collection.filterField);
	if (query.filter === null || field?.options?.includes(query.filter)) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`${collection.name} can't be narrowed to ${query.filter}`));
}
