import {z} from 'zod';

import type {MemberViewer} from '@proxy/db/connection';

// Whose a new connection is: the connecting member's own, or, `shared`, every member's of the
// organization; either way it was connected by them.
export function ownership(viewer: MemberViewer, shared: boolean): {orgId: string; ownerUserId: string | null; connectedById: string} {
	return {orgId: viewer.orgId, ownerUserId: shared ? null : viewer.userId, connectedById: viewer.userId};
}

// `shared` beside what a connect form sends: true shares the new connection with every member.
export const shareBodySchema = z.object({shared: z.boolean().optional()});
