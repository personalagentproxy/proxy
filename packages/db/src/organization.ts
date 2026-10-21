import {Prisma} from '@prisma/client';

import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';

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

// A person's place in an organization: its owner (`Organization.ownerUserId`), or a member.
export type OrgRole = 'owner' | 'member';

function roleOf(userId: string, org: {ownerUserId: string}): OrgRole {
	return org.ownerUserId === userId ? 'owner' : 'member';
}

// The membership a user works in: `preferred`, the organization their session has open, while they
// are a member of it, else the first one they joined.
async function workingMembership<S extends Prisma.OrgMemberSelect>(
	userId: string,
	preferred: string | null,
	select: S,
) {
	const open = preferred
		? await db.orgMember.findFirst({where: {userId, orgId: preferred}, select})
		: null;
	return open ?? db.orgMember.findFirst({where: {userId}, select, orderBy: {createdAt: 'asc'}});
}

/**
 * The organization a user works in: `preferred`, the one their session has open, while they are a
 * member of it, else the first one they joined. `Ok(null)` means they are in none: the user is gone.
 */
export async function getUserOrgId(
	userId: string,
	preferred: string | null = null,
): Promise<Result<string | null, ApiError>> {
	return (await wrapDb(() => workingMembership(userId, preferred, {orgId: true}))).map(
		(member) => member?.orgId ?? null,
	);
}

export type UserOrganization = {id: string; name: string; role: OrgRole; onboardedAt: Date | null};

/**
 * The organization a user works in, as `getUserOrgId` picks it, with their role there and whether
 * it has been through the welcome flow; `Ok(null)` means they are in none.
 */
export async function getUserOrganization(
	userId: string,
	preferred: string | null = null,
): Promise<Result<UserOrganization | null, ApiError>> {
	return (
		await wrapDb(() =>
			workingMembership(userId, preferred, {
				org: {select: {id: true, name: true, onboardedAt: true, ownerUserId: true}},
			}),
		)
	).map((member) => {
		if (!member) {
			return null;
		}
		const {ownerUserId, ...org} = member.org;
		return {...org, role: roleOf(userId, {ownerUserId})};
	});
}

/** The person's role in an organization; `Ok(null)` when they aren't a member of it. */
export async function getMembership(
	userId: string,
	orgId: string,
): Promise<Result<{role: OrgRole} | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.orgMember.findUnique({
				where: {orgId_userId: {orgId, userId}},
				select: {org: {select: {ownerUserId: true}}},
			}),
		)
	).map((member) => (member ? {role: roleOf(userId, member.org)} : null));
}

export type UserOrgRow = {
	id: string;
	name: string;
	role: OrgRole;
	memberCount: number;
	// Invitations not taken up yet, expired ones included.
	invitationCount: number;
};

/**
 * The organizations the person is a member of, the first one joined first, with how many members
 * and invitations each has.
 */
export async function listUserOrgs(userId: string): Promise<Result<UserOrgRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.orgMember.findMany({
				where: {userId},
				orderBy: {createdAt: 'asc'},
				select: {
					org: {
						select: {
							id: true,
							name: true,
							ownerUserId: true,
							_count: {select: {members: true, invitations: true}},
						},
					},
				},
			}),
		)
	).map((memberships) =>
		memberships.map(({org}) => ({
			id: org.id,
			name: org.name,
			role: roleOf(userId, org),
			memberCount: org._count.members,
			invitationCount: org._count.invitations,
		})),
	);
}

const MAX_SLUG_ATTEMPTS = 5;

/**
 * A new organization, the person its owner, with its vault as a sign-up's organization has it. It
 * has been through the welcome flow from the start: that is the first organization's. Retries
 * when a parallel creation took the slug.
 */
export async function createOrganization(data: {
	userId: string;
	name: string;
}): Promise<Result<{id: string; name: string}, ApiError>> {
	const {userId, name} = data;
	const base = buildBaseSlug(name);
	for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
		const result = await wrapDb(() =>
			db.$transaction(async (tx) => {
				const slug = await pickAvailableSlugDatabase(tx, base);
				const org = await tx.organization.create({
					data: {name, slug, ownerUserId: userId, onboardedAt: new Date()},
					select: {id: true, name: true},
				});
				await tx.orgMember.create({data: {orgId: org.id, userId}});
				await tx.connection.create({
					data: {
						orgId: org.id,
						integrationId: 'vault',
						account: name,
						defaults: {create: [{actionId: 'readEntries'}, {actionId: 'writeEntries'}]},
					},
				});
				return org;
			}),
		);
		if (result.isOk() || !isSlugUniqueConflict(result.error)) {
			return result;
		}
	}
	return Err(ApiErr.dbError(new Error(`Slug conflict retries exhausted for base "${base}"`)));
}

export async function renameOrganization(
	orgId: string,
	name: string,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.organization.update({where: {id: orgId}, data: {name}, select: {id: true}}),
		)
	).map(() => undefined);
}

export type MemberRow = {
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
	role: OrgRole;
	joinedAt: Date;
};

/** The organization's members, the first one joined first. */
export async function listMembers(orgId: string): Promise<Result<MemberRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.orgMember.findMany({
				where: {orgId},
				orderBy: {createdAt: 'asc'},
				select: {
					createdAt: true,
					org: {select: {ownerUserId: true}},
					user: {select: {id: true, name: true, email: true, image: true}},
				},
			}),
		)
	).map((members) =>
		members.map(({createdAt, org, user}) => ({
			userId: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			role: roleOf(user.id, org),
			joinedAt: createdAt,
		})),
	);
}

/** Takes a person out of an organization. The caller has checked they aren't its owner. */
export async function removeMembership(data: {
	orgId: string;
	userId: string;
}): Promise<Result<void, ApiError>> {
	const {orgId, userId} = data;
	return (await wrapDb(() => db.orgMember.deleteMany({where: {orgId, userId}}))).map(
		() => undefined,
	);
}

/**
 * Deletes an organization; the cascades take its memberships, connections, vault, agents,
 * invitations and activity. The caller has undone its connections at their providers first.
 */
export async function deleteOrganization(orgId: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.organization.deleteMany({where: {id: orgId}}))).map(
		() => undefined,
	);
}

/** Marks the welcome flow done, once: a second finish keeps the first time. */
export async function markOrganizationOnboarded(orgId: string): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.organization.updateMany({
				where: {id: orgId, onboardedAt: null},
				data: {onboardedAt: new Date()},
			}),
		)
	).map(() => undefined);
}
