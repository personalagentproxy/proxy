import {describe, expect, test} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {unknownTimeZoneAs} from './audit';

function rawQueryFailed(code: string, message: string) {
	return ApiErr.dbError(
		new Prisma.PrismaClientKnownRequestError('Raw query failed', {
			code: 'P2010',
			clientVersion: 'test',
			meta: {code, message},
		}),
	);
}

describe('unknownTimeZoneAs', () => {
	test('turns a time zone the database has no rules for into a validation error, and nothing else', () => {
		const asValidation = unknownTimeZoneAs('America/Ciudad_Juarez');
		const unknown = rawQueryFailed(
			'22023',
			'ERROR: time zone "America/Ciudad_Juarez" not recognized',
		);
		const other = rawQueryFailed('57014', 'ERROR: canceling statement due to statement timeout');

		expect(asValidation(unknown)).toEqual(
			ApiErr.validationError('The database doesn’t know the time zone America/Ciudad_Juarez'),
		);
		expect(asValidation(other)).toBe(other);
		expect(asValidation(ApiErr.forbidden())).toEqual(ApiErr.forbidden());
	});
});
