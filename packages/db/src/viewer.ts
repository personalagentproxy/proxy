import type {Prisma} from '@prisma/client';

// Who is looking at an organization's connections, agents, tasks and activity: a member, or a
// shared agent (`userId` null), which stands for every member of the organization at once.
export type Viewer = {orgId: string; userId: string | null};

/** A member looking at the organization: a viewer with a user, who also connects, shares and changes things. */
export type MemberViewer = {orgId: string; userId: string};

/**
 * The agents, tasks and activity of an organization a viewer sees, for a `where` on anything with
 * an `ownerUserId`: the shared ones, whose owner is null, and the viewer's own, never another
 * member's.
 */
export function visibleTo(viewer: Viewer): {
	orgId: string;
	OR: Array<{ownerUserId: string | null}>;
} {
	if (viewer.userId === null) {
		return {orgId: viewer.orgId, OR: [{ownerUserId: null}]};
	}
	return {orgId: viewer.orgId, OR: [{ownerUserId: null}, {ownerUserId: viewer.userId}]};
}

/**
 * The connections of an organization a viewer uses, for a `where` on them: a member, their own,
 * those shared with them by name and those shared with every member; a shared agent, those shared
 * with every member alone, since anything else would reach members it isn't shared with. One
 * without an owner is nobody's (schema.prisma), so never among them.
 */
export function usableBy(viewer: Viewer): Prisma.ConnectionWhereInput {
	const everyones = {sharedWithEveryone: true, ownerUserId: {not: null}};
	if (viewer.userId === null) {
		return {orgId: viewer.orgId, ...everyones};
	}
	return {
		orgId: viewer.orgId,
		OR: [{ownerUserId: viewer.userId}, everyones, {shares: {some: {userId: viewer.userId}}}],
	};
}

/**
 * A member's connections that leave an organization with them, for a `where` on them: all but
 * those shared with every member, which stay (organization.ts removeMembership).
 */
export function leavingWith(member: MemberViewer): Prisma.ConnectionWhereInput {
	return {orgId: member.orgId, ownerUserId: member.userId, sharedWithEveryone: false};
}
