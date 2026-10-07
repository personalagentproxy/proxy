import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

/** The catalog's collection of a connection's integration, or not_found. */
export function requireCollection(integrationId: string, collectionId: string): Result<Collection, ApiError> {
	const integration = findIntegration(integrationId);
	const collection = integration && findCollection(integration, collectionId);
	if (!collection) {
		return Err(ApiErr.notFound('collection', collectionId));
	}
	return Ok(collection);
}

/**
 * The actions a request turns on or off, by id, refusing any the collection doesn't have. `schema`
 * is what each may be set to: on or off for a default, or null too for an agent's own setting.
 */
export function parseActionChanges<T>(collection: Collection, schema: z.ZodType<T>, body: unknown): Result<Record<string, T>, ApiError> {
	const parsed = parseSchema(z.object({actions: z.record(z.string(), schema)}), body);
	if (parsed.isErr()) {
		return parsed;
	}

	const {actions} = parsed.value;
	const unknown = Object.keys(actions).find((id) => !collection.actions.some((action) => action.id === id));
	if (unknown !== undefined) {
		return Err(ApiErr.validationError(`${collection.name} has no action ${unknown}`));
	}
	return Ok(actions);
}
