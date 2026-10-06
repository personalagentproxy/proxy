import {Prisma} from '@prisma/client';

import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * Normalizes a string into the `[a-z0-9-]+` slug shape (max 48 chars, no leading or trailing
 * dashes). Accents are stripped rather than replaced, so "Vinícius" becomes "vinicius"; scripts
 * that don't decompose to Latin collapse to the "workspace" fallback.
 */
export function buildBaseSlug(source: string): string {
	let base = source.normalize('NFD').replace(/\p{M}/gu, '');
	base = base.toLowerCase().replace(/'/g, '');
	base = base.replace(/[^a-z0-9]+/g, '-');
	base = base.replace(/^-+|-+$/g, '').slice(0, 48);
	base = base.replace(/^-+|-+$/g, '');
	if (!base) {
		base = 'workspace';
	}
	return base;
}

/**
 * The display name and slug source of a user's personal organization: `<First>'s Workspace`,
 * else `<email-local>'s Workspace`. A first name with no Latin letters still names the
 * organization, but the slug comes from the email so it isn't just `s-workspace`.
 */
export function planPersonalOrgIdentity(identity: {name?: string | null; email: string}): {
	name: string;
	slugSource: string;
} {
	const firstName = (identity.name?.trim() ?? '').split(/\s+/)[0] ?? '';
	const emailLocal = identity.email.split('@')[0]?.trim() ?? '';

	const display = firstName || emailLocal;
	const name = display ? `${display}'s Workspace` : 'Workspace';

	const firstNameYieldsLatinSlug = firstName && buildBaseSlug(firstName) !== 'workspace';
	const slugDisplay = firstNameYieldsLatinSlug ? firstName : emailLocal || display;
	const slugSource = slugDisplay ? `${slugDisplay}'s Workspace` : 'Workspace';

	return {name, slugSource};
}

export async function pickAvailableSlugDatabase(
	tx: Pick<typeof db, 'organization'>,
	base: string,
): Promise<string> {
	let candidate = base;
	let suffix = 1;
	while (suffix < 100) {
		const existing = await tx.organization.findUnique({
			where: {slug: candidate},
			select: {id: true},
		});
		if (!existing) {
			return candidate;
		}
		suffix += 1;
		candidate = `${base}-${suffix}`;
	}
	throw new Error(`Could not pick a unique org slug for base "${base}"`);
}

// Two sign-ups with the same base slug can both find it free before either inserts, so one fails
// on the unique slug. Callers retry the whole pick-then-insert when this is the error.
export function isSlugUniqueConflict(error: ApiError): boolean {
	if (error.kind !== 'db_error') {
		return false;
	}

	const cause = error.cause;
	if (!(cause instanceof Prisma.PrismaClientKnownRequestError) || cause.code !== 'P2002') {
		return false;
	}

	const target = cause.meta?.target;
	return Array.isArray(target) && target.includes('slug');
}

/**
 * The organization a user works in. Every user has exactly one, made at sign-up; `Ok(null)` means
 * the user is gone.
 */
export async function getUserOrgId(userId: string): Promise<Result<string | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.orgMember.findFirst({where: {userId}, select: {orgId: true}, orderBy: {createdAt: 'asc'}}),
		)
	).map((member) => member?.orgId ?? null);
}
