import type {MemberViewer} from '@proxy/db/viewer';

// Whose a new connection is: the connecting member's, theirs alone to use or, `shared`, every
// member's of the organization too.
export function ownership(viewer: MemberViewer, shared: boolean): {orgId: string; ownerUserId: string; sharedWithEveryone: boolean} {
	return {orgId: viewer.orgId, ownerUserId: viewer.userId, sharedWithEveryone: shared};
}
