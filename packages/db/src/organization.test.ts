import {describe, expect, it} from 'bun:test';

import {Prisma} from '@prisma/client';
import {ApiErr} from '@proxy/utils';

import {buildBaseSlug, isSlugUniqueConflict, pickAvailableSlugDatabase} from './organization';

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

describe('isSlugUniqueConflict', () => {
	it('is true for a unique violation on the slug', () => {
		expect(isSlugUniqueConflict(uniqueViolation(['slug']))).toBe(true);
	});

	it('is false for a unique violation on anything else, such as the email', () => {
		expect(isSlugUniqueConflict(uniqueViolation(['email']))).toBe(false);
		expect(isSlugUniqueConflict(ApiErr.forbidden())).toBe(false);
	});
});

describe('pickAvailableSlugDatabase', () => {
	// Organizations by slug, as the database has them.
	function withSlugs(slugs: string[]) {
		return {
			organization: {
				findUnique: async ({where}: {where: {slug: string}}) =>
					slugs.includes(where.slug) ? {id: `org-${where.slug}`} : null,
			},
		};
	}

	it('takes the base when it is free, else numbers it', async () => {
		expect(await pickAvailableSlugDatabase(withSlugs([]), 'acme')).toBe('acme');
		expect(await pickAvailableSlugDatabase(withSlugs(['acme', 'acme-2']), 'acme')).toBe('acme-3');
	});

	it('never takes a top-level path of the app or the api', async () => {
		for (const path of ['api', 'mcp', 'login', 'invite', 'agent', 'oauth', 'assets', 'account']) {
			expect(await pickAvailableSlugDatabase(withSlugs([]), path)).toBe(`${path}-2`);
		}
	});
});
