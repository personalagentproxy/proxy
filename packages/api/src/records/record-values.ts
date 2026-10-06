import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import type {Collection} from '@proxy/integrations';

import type {RecordValues} from './connector';

const valuesSchema = z.record(z.string(), z.string());

/**
 * The values a create or update may set: every field that is typed in, missing ones empty. Fields
 * the provider sets, unknown fields and options a select doesn't have are refused.
 */
export function parseRecordValues(collection: Collection, input: unknown): Result<RecordValues, ApiError> {
	const parsed = parseSchema(valuesSchema, input);
	if (parsed.isErr()) {
		return parsed;
	}

	const editable = collection.fields.filter((field) => !field.system);
	const unknown = Object.keys(parsed.value).find((key) => !editable.some((field) => field.key === key));
	if (unknown !== undefined) {
		return Err(ApiErr.validationError(`${unknown} can't be set`));
	}

	const values: RecordValues = {};
	for (const field of editable) {
		const value = parsed.value[field.key] ?? '';
		if (field.options && value !== '' && !field.options.includes(value)) {
			return Err(ApiErr.validationError(`${field.key} must be one of ${field.options.join(', ')}`));
		}
		values[field.key] = value;
	}
	return Ok(values);
}
