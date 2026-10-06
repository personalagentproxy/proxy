import {describe, expect, it} from 'bun:test';
import {Err, Ok} from 'ts-results-es';
import {z} from 'zod';

import {Do} from './do';
import {parseSchema, requirePresent} from './parse';

describe('Do', () => {
	it('returns Ok with the async body value when every Result is Ok', async () => {
		const result = await Do<number, string>(async ($) => {
			const a = $(Ok(1));
			const b = $(await Promise.resolve(Ok(2)));
			return a + b;
		});

		expect(result.unwrap()).toBe(3);
	});

	it('short-circuits on the first Err and skips the rest of the body', async () => {
		let reached = false;
		const result = await Do<number, string>(async ($) => {
			$(Err('first'));
			reached = true;
			return $(Err('second'));
		});

		expect(result.unwrapErr()).toBe('first');
		expect(reached).toBe(false);
	});

	it('runs a sync body without a promise', () => {
		const ok = Do<number, string>(($) => $(Ok(2)) * 2);
		const err = Do<number, string>(($) => $<number>(Err('nope')));

		expect(ok.unwrap()).toBe(4);
		expect(err.unwrapErr()).toBe('nope');
	});

	it('rethrows anything thrown that is not an Err', async () => {
		const boom = new Error('boom');

		expect(() =>
			Do(() => {
				throw boom;
			}),
		).toThrow(boom);
		await expect(
			Do(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
	});
});

describe('parseSchema', () => {
	const schema = z.object({id: z.string()});

	it('returns the parsed value', () => {
		expect(parseSchema(schema, {id: 'a'}).unwrap()).toEqual({id: 'a'});
	});

	it('returns a parse_error when the value does not match', () => {
		const error = parseSchema(schema, {id: 1}).unwrapErr();

		expect(error.kind).toBe('parse_error');
		expect(error.statusCode).toBe(400);
	});
});

describe('requirePresent', () => {
	it('passes a present value through, falsy ones included', () => {
		expect(requirePresent(0, 'missing').unwrap()).toBe(0);
	});

	it('returns the error for null and undefined', () => {
		expect(requirePresent(null, 'missing').unwrapErr()).toBe('missing');
		expect(requirePresent(undefined, 'missing').unwrapErr()).toBe('missing');
	});
});
