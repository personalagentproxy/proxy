import {Prisma} from '@prisma/client';

import {Err, Ok, type Result} from 'ts-results-es';

import {
	ApiErr,
	type ApiError,
	type Experiment,
	organizationExperiments,
	wrapDb,
} from '@proxy/utils';

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

// An organization's address is `/<slug>`, so no slug can be a top-level path of the web app
// (`/login`, `/agent`, …), of the api it serves on the same origin (`/api`, `/mcp`, …), or of the
// web app's files (`/assets`, …).
const RESERVED_SLUGS = new Set([
	'agent',
	'agent-auth',
	'agent-providers',
	'api',
	'assets',
	'auth',
	'connect-agent',
	'health',
	'integrations',
	'invite',
	'login',
	'mcp',
	'oauth',
]);

/** The base slug, else the base numbered (`acme-2`), whichever no organization has and no path is. */
export async function pickAvailableSlugDatabase(
	tx: {
		organization: {
			findUnique: (args: {
				where: {slug: string};
				select: {id: true};
			}) => Promise<{id: string} | null>;
		};
	},
	base: string,
): Promise<string> {
	let candidate = base;
	let suffix = 1;
	while (suffix < 100) {
		const taken =
			RESERVED_SLUGS.has(candidate) ||
			(await tx.organization.findUnique({where: {slug: candidate}, select: {id: true}})) !== null;
		if (!taken) {
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

export type MemberOrganization = {
	id: string;
	slug: string;
	name: string;
	role: OrgRole;
	onboardedAt: Date | null;
	// The experiments on for it.
	experiments: Experiment[];
};

/**
 * An organization by its slug, as the web app's and the api's addresses name it, for a member of
 * it: `Ok(null)` when there is none, or the person isn't in it, which is told apart from no such
 * organization nowhere, so nothing says which organizations exist.
 */
export async function getMemberOrganization(
	userId: string,
	slug: string,
): Promise<Result<MemberOrganization | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.orgMember.findFirst({
				where: {userId, org: {slug}},
				select: {
					org: {
						select: {
							id: true,
							slug: true,
							name: true,
							onboardedAt: true,
							ownerUserId: true,
							insider: true,
							experiments: true,
						},
					},
				},
			}),
		)
	).map((member) => {
		if (!member) {
			return null;
		}
		const {ownerUserId, insider, experiments, ...org} = member.org;
		return {
			...org,
			role: roleOf(userId, {ownerUserId}),
			experiments: organizationExperiments({insider, experiments}),
		};
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
	slug: string;
	name: string;
	role: OrgRole;
	// Whether it has been through the welcome flow.
	onboarded: boolean;
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
							slug: true,
							name: true,
							onboardedAt: true,
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
			slug: org.slug,
			name: org.name,
			role: roleOf(userId, org),
			onboarded: org.onboardedAt !== null,
			memberCount: org._count.members,
			invitationCount: org._count.invitations,
		})),
	);
}

const MAX_SLUG_ATTEMPTS = 5;

/**
 * A new organization, with its shared vault, the person its owner with their own vault there, as
 * every member of an organization has. It has been through the welcome flow from the start: that
 * is the first organization's. Retries when a parallel creation took the slug.
 */
export async function createOrganization(data: {
	userId: string;
	name: string;
}): Promise<Result<{id: string; slug: string; name: string}, ApiError>> {
	const {userId, name} = data;
	const base = buildBaseSlug(name);
	for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
		const result = await wrapDb(() =>
			db.$transaction(async (tx) => {
				const slug = await pickAvailableSlugDatabase(tx, base);
				const org = await tx.organization.create({
					data: {name, slug, ownerUserId: userId, onboardedAt: new Date()},
					select: {id: true, slug: true, name: true},
				});
				await tx.orgMember.create({data: {orgId: org.id, userId}});
				await tx.connection.create({data: ownVaultFor({orgId: org.id, userId, name})});
				await tx.connection.create({data: sharedVaultFor({orgId: org.id, userId, name})});
				return org;
			}),
		);
		if (result.isOk() || !isSlugUniqueConflict(result.error)) {
			return result;
		}
	}
	return Err(ApiErr.dbError(new Error(`Slug conflict retries exhausted for base "${base}"`)));
}

/** Renames an organization, and its vaults with it, which are called by its name. */
export async function renameOrganization(
	orgId: string,
	name: string,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction([
				db.organization.update({where: {id: orgId}, data: {name}, select: {id: true}}),
				db.connection.updateMany({where: {orgId, integrationId: 'vault'}, data: {account: name}}),
			]),
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

/**
 * What members are called, their name or else their address, by organization and person, as who
 * connected a connection is shown; someone no longer in the organization is left out.
 */
export async function listMemberNames(
	members: Array<{orgId: string; userId: string}>,
): Promise<Result<Array<{orgId: string; userId: string; name: string}>, ApiError>> {
	if (members.length === 0) {
		return Ok([]);
	}
	return (
		await wrapDb(() =>
			db.orgMember.findMany({
				where: {OR: members},
				select: {orgId: true, userId: true, user: {select: {name: true, email: true}}},
			}),
		)
	).map((rows) =>
		rows.map(({orgId, userId, user}) => ({orgId, userId, name: user.name ?? user.email})),
	);
}

// A vault, as the organization's name: agents read it and keep what they learn there, unless told
// otherwise.
function vaultFor(data: {
	orgId: string;
	ownerUserId: string | null;
	connectedById: string;
	name: string;
}): Prisma.ConnectionUncheckedCreateInput {
	return {
		orgId: data.orgId,
		ownerUserId: data.ownerUserId,
		connectedById: data.connectedById,
		integrationId: 'vault',
		account: data.name,
		defaults: {create: [{actionId: 'readEntries'}, {actionId: 'writeEntries'}]},
	};
}

/**
 * A member's own vault in an organization, as they get one on joining it: what their own agents
 * should know about them, which nobody else in the organization sees.
 */
export function ownVaultFor(data: {
	orgId: string;
	userId: string;
	name: string;
}): Prisma.ConnectionUncheckedCreateInput {
	return vaultFor({
		orgId: data.orgId,
		ownerUserId: data.userId,
		connectedById: data.userId,
		name: data.name,
	});
}

/**
 * The organization's vault, made with it by whoever made the organization: what every member's
 * agents should know about it, shared with everyone in it, the shared agents included.
 */
export function sharedVaultFor(data: {
	orgId: string;
	userId: string;
	name: string;
}): Prisma.ConnectionUncheckedCreateInput {
	return vaultFor({
		orgId: data.orgId,
		ownerUserId: null,
		connectedById: data.userId,
		name: data.name,
	});
}

/**
 * Takes a person out of an organization: their own connections there go, with their defaults,
 * entries and every agent's settings on them, and so do their own agents there, with their logins
 * and MCP clients; the shared ones stay, but the MCP clients they signed in as a shared agent are
 * signed out, so nothing of theirs keeps working there. The caller has undone the connections at
 * their providers first, and checked they aren't its owner.
 */
export async function removeMembership(data: {
	orgId: string;
	userId: string;
}): Promise<Result<void, ApiError>> {
	const {orgId, userId} = data;
	return wrapDb(async () => {
		await db.$transaction([
			db.connection.deleteMany({where: {orgId, ownerUserId: userId}}),
			db.agent.deleteMany({where: {orgId, ownerUserId: userId}}),
			db.oAuthCode.deleteMany({where: {userId, agent: {orgId}}}),
			db.oAuthGrant.deleteMany({where: {userId, agent: {orgId}}}),
			db.orgMember.deleteMany({where: {orgId, userId}}),
		]);
	});
}

/**
 * Deletes an organization its owner owns another of, so everyone always owns one: `Ok(false)`
 * when it is the last one they own, which stays. Checked and deleted as one, serializable, so two
 * deletions at once can't each take the other for the one that stays; one of the two then fails
 * to serialize, which is a conflict to try again. The cascades take its memberships,
 * connections, its vault and every member's there, agents, invitations and activity. The caller
 * has undone its connections at their providers first.
 */
export async function deleteOwnedOrganization(data: {
	orgId: string;
	ownerUserId: string;
}): Promise<Result<boolean, ApiError>> {
	const {orgId, ownerUserId} = data;
	const deleted = await wrapDb(() =>
		db.$transaction(
			async (tx) => {
				const others = await tx.organization.count({
					where: {ownerUserId, id: {not: orgId}},
				});
				if (others === 0) {
					return false;
				}
				await tx.organization.deleteMany({where: {id: orgId, ownerUserId}});
				return true;
			},
			{isolationLevel: Prisma.TransactionIsolationLevel.Serializable},
		),
	);
	if (deleted.isErr() && isSerializationFailure(deleted.error)) {
		return Err(ApiErr.conflict('Something else changed your organizations just now. Try again.'));
	}
	return deleted;
}

// Postgres refused to serialize the transaction beside another: Prisma's P2034.
function isSerializationFailure(error: ApiError): boolean {
	if (error.kind !== 'db_error') {
		return false;
	}
	const cause = error.cause;
	return cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2034';
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
