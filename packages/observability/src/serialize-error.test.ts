import {describe, expect, it} from 'bun:test';

import {expandErrors, serializeError} from './serialize-error';

describe('serializeError', () => {
	it('keeps an error’s name, message, stack and cause chain', () => {
		const cause = new TypeError('inner');
		const error = new Error('outer', {cause});
		const out = serializeError(error);
		expect(out.name).toBe('Error');
		expect(out.message).toBe('outer');
		expect(typeof out.stack).toBe('string');
		expect(out.cause).toMatchObject({name: 'TypeError', message: 'inner'});
	});

	it('expands an error inside a plain object, where JSON.stringify would make it {}', () => {
		const out = serializeError({kind: 'db_error', statusCode: 500, cause: new Error('boom')});
		expect(out).toEqual({
			error: {
				kind: 'db_error',
				statusCode: 500,
				cause: expect.objectContaining({name: 'Error', message: 'boom'}),
			},
		});
	});

	it('does not loop on a circular cause', () => {
		const a = new Error('a');
		const b = new Error('b', {cause: a});
		// As the constructor sets it: not enumerable, so it is read as a cause, not as a property.
		Object.defineProperty(a, 'cause', {value: b, enumerable: false});
		const out = serializeError(a);
		expect(out.message).toBe('a');
		expect(out.cause).toMatchObject({message: 'b', cause: {message: 'a', circular: true}});
	});

	it('wraps a primitive', () => {
		expect(serializeError('nope')).toEqual({error: 'nope'});
		expect(serializeError(undefined)).toEqual({error: 'undefined'});
	});
});

describe('expandErrors', () => {
	it('expands errors nested in arrays and objects, and leaves the rest as it is', () => {
		const out = expandErrors({a: 1, list: [new Error('x'), 'y'], nested: {ok: true}});
		expect(out).toEqual({
			a: 1,
			list: [expect.objectContaining({message: 'x'}), 'y'],
			nested: {ok: true},
		});
	});

	it('marks a circular object instead of looping', () => {
		const value: Record<string, unknown> = {name: 'self'};
		value.self = value;
		expect(expandErrors(value)).toEqual({name: 'self', self: '[Circular]'});
	});
});
