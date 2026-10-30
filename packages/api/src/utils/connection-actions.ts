import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import {integrationFor, mcpToolSchema, type Integration, type McpTool} from '@proxy/integrations';

import {log} from '../observability/log';

/** A connection as the database holds it: its integration and, for a custom MCP server, its tools as JSON. */
export type StoredIntegration = {integrationId: string; tools: string | null};

/** A custom MCP server's tools as stored; null for every other integration, and none when the stored list can't be read. */
export function parseStoredTools(json: string | null): McpTool[] | null {
	if (json === null) {
		return null;
	}
	const parsed = Result.wrap((): unknown => JSON.parse(json)).andThen((value) => parseSchema(z.array(z.unknown()), value));
	if (parsed.isErr()) {
		log.warn('A connection’s stored tools could not be read', {error: String(parsed.error)});
		return [];
	}
	return parsed.value.flatMap((tool) => mcpToolSchema.safeParse(tool).data ?? []);
}

/** The integration of a connection, a custom MCP server's with its own tools as actions; undefined for one the catalog no longer has. */
export function integrationOf(connection: StoredIntegration): Integration | undefined {
	return integrationFor({integrationId: connection.integrationId, tools: parseStoredTools(connection.tools)});
}

/** The integration of a connection, or not_found for one the catalog no longer has. */
export function requireIntegration(connection: StoredIntegration): Result<Integration, ApiError> {
	const integration = integrationOf(connection);
	if (!integration) {
		return Err(ApiErr.notFound('integration', connection.integrationId));
	}
	return Ok(integration);
}

/**
 * The actions a request turns on or off, by id, refusing any the integration doesn't have.
 * `schema` is the request's body: each action on or off for a default (`setDefaultsBodySchema`),
 * or null too for an agent's own setting (`setGrantsBodySchema`).
 */
export function parseActionChanges<T>(integration: Integration, schema: z.ZodType<{actions: Record<string, T>}>, body: unknown): Result<Record<string, T>, ApiError> {
	const parsed = parseSchema(schema, body);
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
