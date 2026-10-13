import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * Values an agent reads and writes as text, one "Name: value" a line, a value running on over the
 * lines after it until the next name: a Notion row's properties, a database row's columns.
 */

/** The values written out, one "Name: value" a line, empty ones left out. */
export function valueLines(entries: [string, string][]): string {
	return entries
		.filter(([, text]) => text !== '')
		.map(([name, text]) => `${name}: ${text}`)
		.join('\n');
}

/**
 * The values "Name: value" lines give, by name, for the names given. A line that doesn't start
 * with one of them goes on the value before it; one before any is turned down.
 */
export function readValueLines(text: string, names: string[]): Result<Record<string, string>, ApiError> {
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
			return Err(ApiErr.validationError(`“${line}” doesn’t start with one of the names: ${names.join(', ')}`));
		}
	}
	return Ok(values);
}
