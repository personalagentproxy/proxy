import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import {findIntegration, type Integration} from '@proxy/integrations';

/** The catalog's integration of a connection, or not_found for one it no longer has. */
export function requireIntegration(integrationId: string): Result<Integration, ApiError> {
	const integration = findIntegration(integrationId);
	if (!integration) {
		return Err(ApiErr.notFound('integration', integrationId));
	}
	return Ok(integration);
}

/**
 * The actions a request turns on or off, by id, refusing any the integration doesn't have.
 * `schema` is what each may be set to: on or off for a default, or null too for an agent's own
 * setting.
 */
export function parseActionChanges<T>(integration: Integration, schema: z.ZodType<T>, body: unknown): Result<Record<string, T>, ApiError> {
	const parsed = parseSchema(z.object({actions: z.record(z.string(), schema)}), body);
	if (parsed.isErr()) {
		return parsed;
	}

	const {actions} = parsed.value;
	const unknown = Object.keys(actions).find((id) => !integration.actions.some((action) => action.id === id));
	if (unknown !== undefined) {
		return Err(ApiErr.validationError(`${integration.name} has no action ${unknown}`));
	}
	return Ok(actions);
}
