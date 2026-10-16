import {describe, expect, test} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {isProviderConflict, isUsernameConflict} from './agent';
import {toSignedInAgent} from './signed-in-agent';

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

describe('toSignedInAgent', () => {
	const agent = {
		id: 'agent-1',
		orgId: 'org-1',
		providerId: 'claude',
		name: 'Claude',
		revokedAt: null,
		org: {insider: false, experiments: ['shipped-long-ago']},
	};

	test("carries its organization's experiments, without ids that are no longer experiments", () => {
		expect(toSignedInAgent(agent)).toEqual({
			agentId: 'agent-1',
			orgId: 'org-1',
			providerId: 'claude',
			name: 'Claude',
			experiments: [],
		});
	});

	test('is no one once revoked', () => {
		expect(toSignedInAgent({...agent, revokedAt: new Date()})).toBeNull();
	});
});
