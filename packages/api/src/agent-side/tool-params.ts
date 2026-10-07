import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {Tool} from '@proxy/integrations';

const MAX_SEARCH_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool's params, checked against its input schema: an object of text, nothing it doesn't take,
 * an enum's values only, and every required one there. Left out entirely, a tool gets none. The
 * messages say what to change, for a model reading them.
 */
export function parseToolParams(tool: Tool, params: unknown): Result<Record<string, string>, ApiError> {
	const given = params ?? {};
	if (!isPlainObject(given)) {
		return Err(ApiErr.validationError(`${tool.name} takes an object of params`));
	}

	const {properties, required} = tool.inputSchema;
	const known = Object.keys(properties);
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(given)) {
		const property = properties[key];
		if (!property) {
			const takes = known.length > 0 ? `; it takes ${known.join(', ')}` : '; it takes none';
			return Err(ApiErr.validationError(`${tool.name} takes no ${key}${takes}`));
		}
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value !== 'string') {
			return Err(ApiErr.validationError(`${key} must be text`));
		}
		if (property.enum && !property.enum.includes(value)) {
			return Err(ApiErr.validationError(`${key} must be one of ${property.enum.join(', ')}`));
		}
		values[key] = value;
	}

	const missing = required.find((key) => !values[key]);
	if (missing !== undefined) {
		return Err(ApiErr.validationError(`${tool.name} needs ${missing}`));
	}
	if ((values.search?.length ?? 0) > MAX_SEARCH_LENGTH) {
		return Err(ApiErr.validationError(`search can be at most ${MAX_SEARCH_LENGTH} characters`));
	}
	return Ok(values);
}
