// Who is looking at an organization's connections, agents, tasks and activity: a member, who sees
// what is shared with every member of it and their own, never another member's, or a shared agent
// (`userId` null), which sees the shared ones alone.
export type Viewer = {orgId: string; userId: string | null};

/** A member looking at the organization: a viewer with a user, who also connects, shares and changes things. */
export type MemberViewer = {orgId: string; userId: string};

/**
 * The rows of an organization a viewer sees, for a `where` on anything with an `ownerUserId`: the
 * shared ones, whose owner is null, and the viewer's own.
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
