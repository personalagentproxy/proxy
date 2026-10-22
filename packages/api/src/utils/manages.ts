import type {OrgRole} from '@proxy/db/organization';

/**
 * Whether a member may change something they see in the organization, a connection or an agent:
 * their own, or a shared one they connected or made (`byId`) or whose organization they own.
 * Anyone else uses a shared one as it is.
 */
export function manages(viewer: {userId: string; role: OrgRole}, thing: {ownerUserId: string | null; byId: string | null}): boolean {
	return thing.ownerUserId !== null || thing.byId === viewer.userId || viewer.role === 'owner';
}
