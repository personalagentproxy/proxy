import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, parseSchema} from '@proxy/utils';

import type {ListQuery} from './connector';

const listQuerySchema = z.object({
	search: z.string().trim().max(200).optional(),
	page: z.string().min(1).optional(),
});

/** `?search=…&page=…` from a list request; an empty search lists everything. */
export function parseListQuery(query: unknown): Result<ListQuery, ApiError> {
	return parseSchema(listQuerySchema, query).map(({search, page}) => ({search: search || null, page: page ?? null}));
}
