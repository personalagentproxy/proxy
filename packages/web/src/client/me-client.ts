import {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

const meSchema = z.object({
	user: z.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		image: z.string().nullable(),
	}),
});

export type Me = z.infer<typeof meSchema>;

/** Who is signed in (`GET /api/me`). A 401 means "redirect to /login". The organizations they are in are `listOrgs`. */
export function getMe() {
	return apiRequest('GET', '/api/me', meSchema);
}

/**
 * Deletes the account: every connection in the organizations the person owns is undone at its
 * provider, then the user and those organizations go; the session goes with them.
 */
export function deleteAccount() {
	return apiSend('DELETE', '/api/me');
}
