import {afterEach, describe, expect, it, mock} from 'bun:test';

import {ApiErr, setDbLogger, setDbMetrics, wrapDb} from './api-error';

afterEach(() => {
	setDbLogger(undefined);
	setDbMetrics(undefined);
});

describe('wrapDb', () => {
	it('returns the query result', async () => {
		expect((await wrapDb(async () => 42)).unwrap()).toBe(42);
	});

	it('turns a throw into a db_error and logs it', async () => {
		const warn = mock();
		setDbLogger({warn});
		const cause = new Error('connection refused');

		const error = (await wrapDb(async () => Promise.reject(cause))).unwrapErr();

		expect(error).toEqual({kind: 'db_error', statusCode: 500, cause});
		expect(warn).toHaveBeenCalledWith(
			'db query failed',
			expect.objectContaining({errorKind: 'db_error'}),
		);
	});

	it('records every query, with the kind of error of a failed one', async () => {
		const recordQuery = mock();
		setDbMetrics({recordQuery});

		await wrapDb(async () => 1);
		await wrapDb(async () => Promise.reject(ApiErr.forbidden()));

		expect(recordQuery).toHaveBeenNthCalledWith(1, {success: true, durationMs: expect.any(Number)});
		expect(recordQuery).toHaveBeenNthCalledWith(2, {
			success: false,
			durationMs: expect.any(Number),
			errorKind: 'forbidden',
		});
	});

	it('passes a thrown ApiError through', async () => {
		const error = (await wrapDb(async () => Promise.reject(ApiErr.forbidden()))).unwrapErr();

		expect(error.kind).toBe('forbidden');
	});
});
