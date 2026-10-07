import {describe, expect, test} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {isProviderConflict, isUsernameConflict} from './agent';

function uniqueViolation(target: string[]) {
	return ApiErr.dbError(
		new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002',
			clientVersion: 'test',
			meta: {target},
		}),
	);
}

describe('agent unique conflicts', () => {
	test('distinguishes provider and username constraints', () => {
		const provider = uniqueViolation(['orgId', 'providerId']);
		const username = uniqueViolation(['username']);

		expect(isProviderConflict(provider)).toBe(true);
		expect(isUsernameConflict(provider)).toBe(false);
		expect(isUsernameConflict(username)).toBe(true);
		expect(isProviderConflict(username)).toBe(false);
		expect(isProviderConflict(ApiErr.forbidden())).toBe(false);
	});
});
