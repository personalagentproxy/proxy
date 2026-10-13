import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {propertyText, type NotionProperties} from './notion-mcp';

/**
 * A database row's properties as an agent reads and writes them: one "Name: value" a line
 * (`readValueLines` in the records reads them back). Only properties written differently from how
 * they were read are sent back to Notion, which checks each against the database and turns down
 * what doesn't fit, so a value only has to be written the way it reads.
 */

/** How Notion takes a property's value: text, a number, a list (pages, people, options) or a date. */
export type PropertyShape = 'text' | 'number' | 'list' | 'date';

/** A value Notion's page tools take for a property. */
export type NotionValue = string | number | string[] | null;

// The database property types a value is a list of, and those Notion fills in itself.
const LIST_TYPES = ['multi_select', 'relation', 'person', 'people', 'files'];
const READ_ONLY_TYPES = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'button', 'verification', 'title'];

/** A property's shape, by the database's type for it. Null for those Notion fills in, and the title. */
export function shapeOfType(type: string): PropertyShape | null {
	if (READ_ONLY_TYPES.includes(type)) {
		return null;
	}
	if (LIST_TYPES.includes(type)) {
		return 'list';
	}
	if (type === 'number' || type === 'date') {
		return type;
	}
	return 'text';
}

/** A property's shape, by the value a page has for it. */
export function shapeOfValue(value: NotionProperties[string]): PropertyShape {
	if (Array.isArray(value)) {
		return 'list';
	}
	return typeof value === 'number' ? 'number' : 'text';
}

/** The properties written out, one "Name: value" a line, empty ones left out. */
export function propertyLines(properties: NotionProperties): string {
	return Object.entries(properties)
		.map(([name, value]) => [name, propertyText(value)] as const)
		.filter(([, text]) => text !== '')
		.map(([name, text]) => `${name}: ${text}`)
		.join('\n');
}

/** What Notion's page tools take for one property written as text; an empty one clears it. */
export function notionValues(name: string, shape: PropertyShape, text: string): Result<Record<string, NotionValue>, ApiError> {
	const value = text.trim();
	if (value === '') {
		return Ok(shape === 'date' ? {[`date:${name}:start`]: null} : {[name]: null});
	}
	if (shape === 'list') {
		return Ok({
			[name]: value
				.split(',')
				.map((item) => item.trim())
				.filter((item) => item !== ''),
		});
	}
	if (shape === 'number') {
		const number = Number(value);
		return Number.isFinite(number) ? Ok({[name]: number}) : Err(ApiErr.validationError(`${name} takes a number`));
	}
	if (shape === 'date') {
		return Ok({[`date:${name}:start`]: value, [`date:${name}:is_datetime`]: value.includes('T') ? 1 : 0});
	}
	return Ok({[name]: value});
}
