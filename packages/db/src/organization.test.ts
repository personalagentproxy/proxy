import {describe, expect, it} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {buildBaseSlug, isSlugUniqueConflict, planPersonalOrgIdentity} from './organization';

function uniqueViolation(target: string[]) {
	return ApiErr.dbError(
		new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002',
			clientVersion: 'test',
			meta: {target},
		}),
	);
}

describe('buildBaseSlug', () => {
	it('strips accents instead of replacing them', () => {
		expect(buildBaseSlug('Vinícius Workspace')).toBe('vinicius-workspace');
	});

	it('falls back to "workspace" when nothing Latin is left', () => {
		expect(buildBaseSlug('Алексей')).toBe('workspace');
	});

	it('caps the slug at 48 characters without a trailing dash', () => {
		const slug = buildBaseSlug(`${'a'.repeat(47)} b`);

		expect(slug).toBe('a'.repeat(47));
	});
});

describe('planPersonalOrgIdentity', () => {
	it('names the organization after the first name', () => {
		expect(planPersonalOrgIdentity({name: 'Ann Lee', email: 'ann@example.com'})).toEqual({
			name: "Ann's Workspace",
			slugSource: "Ann's Workspace",
		});
	});

	it('falls back to the email when there is no name', () => {
		expect(planPersonalOrgIdentity({name: null, email: 'ann.lee@example.com'}).name).toBe(
			"ann.lee's Workspace",
		);
	});

	it('keeps a non-Latin name but takes the slug from the email', () => {
		expect(planPersonalOrgIdentity({name: 'Алексей', email: 'alex@example.com'})).toEqual({
			name: "Алексей's Workspace",
			slugSource: "alex's Workspace",
		});
	});
});

describe('isSlugUniqueConflict', () => {
	it('is true for a unique violation on the slug', () => {
		expect(isSlugUniqueConflict(uniqueViolation(['slug']))).toBe(true);
	});

	it('is false for a unique violation on anything else, such as the email', () => {
		expect(isSlugUniqueConflict(uniqueViolation(['email']))).toBe(false);
		expect(isSlugUniqueConflict(ApiErr.forbidden())).toBe(false);
	});
});
