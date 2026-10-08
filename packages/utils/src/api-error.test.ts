import {afterEach, describe, expect, it, mock} from 'bun:test';

import {ApiErr, setDbLogger, wrapDb} from './api-error';

afterEach(() => {
	setDbLogger(undefined);
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

	it('passes a thrown ApiError through', async () => {
		const error = (await wrapDb(async () => Promise.reject(ApiErr.forbidden()))).unwrapErr();

		expect(error.kind).toBe('forbidden');
	});
});
