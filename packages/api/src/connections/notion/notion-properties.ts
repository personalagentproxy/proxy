import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {propertyText, type NotionProperties} from './notion-mcp';

/**
 * A database row's properties as an agent reads and writes them: one "Name: value" a line, a value
 * running on over the lines after it until the next property's name. Only properties written
 * differently from how they were read are sent back to Notion, which checks each against the
 * database and turns down what doesn't fit, so a value only has to be written the way it reads.
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

/**
 * The values "Name: value" lines give, by property, for the properties `names` lists. A line that
 * doesn't start with one of them goes on the value before it; one before any is turned down.
 */
export function readPropertyLines(text: string, names: string[]): Result<Record<string, string>, ApiError> {
	// The longest name first, so "Status Details" isn't read as "Status".
	const byLength = [...names].sort((a, b) => b.length - a.length);
	const values: Record<string, string> = {};
	let current: string | null = null;
	for (const line of text.split('\n')) {
		const name = byLength.find((candidate) => line === `${candidate}:` || line.startsWith(`${candidate}: `));
		if (name !== undefined) {
			current = name;
			values[name] = line.slice(name.length + 1).replace(/^ /, '');
			continue;
		}
		if (current !== null) {
			values[current] = `${values[current]}\n${line}`;
			continue;
		}
		if (line.trim() !== '') {
			return Err(ApiErr.validationError(`“${line}” doesn’t start with one of the properties: ${names.join(', ')}`));
		}
	}
	return Ok(values);
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
