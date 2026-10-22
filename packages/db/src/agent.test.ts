import {describe, expect, test} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {isUsernameConflict} from './agent';
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
	test('recognizes the username constraint alone', () => {
		expect(isUsernameConflict(uniqueViolation(['username']))).toBe(true);
		expect(isUsernameConflict(uniqueViolation(['id']))).toBe(false);
		expect(isUsernameConflict(ApiErr.forbidden())).toBe(false);
	});
});

describe('toSignedInAgent', () => {
	const agent = {
		id: 'agent-1',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		providerId: 'claude',
		name: 'Claude',
		revokedAt: null,
		org: {slug: 'alexs-workspace', insider: false, experiments: ['shipped-long-ago']},
	};

	test("carries its organization's experiments, without ids that are no longer experiments", () => {
		expect(toSignedInAgent(agent)).toEqual({
			agentId: 'agent-1',
			orgId: 'org-1',
			ownerUserId: 'user-1',
			providerId: 'claude',
			name: 'Claude',
			orgSlug: 'alexs-workspace',
			experiments: [],
		});
	});

	test('is no one once revoked', () => {
		expect(toSignedInAgent({...agent, revokedAt: new Date()})).toBeNull();
	});
});
