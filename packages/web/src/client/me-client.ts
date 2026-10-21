import {httpRequest, isExperiment, type FetchError} from '@proxy/utils';
import {z} from 'zod';
import {apiSend} from '@/client/request';

const meSchema = z.object({
	user: z.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		image: z.string().nullable(),
	}),
	// The organization open in the switcher, and the person's role there.
	org: z.object({id: z.string(), name: z.string(), role: z.enum(['owner', 'member'])}),
	// False until the welcome flow is finished or skipped; the human side shows it until then.
	onboarded: z.boolean(),
	// The experiments on for the organization; read them with useExperiments.
	experiments: z.array(z.string()).transform((ids) => ids.filter(isExperiment)),
});

export type Me = z.infer<typeof meSchema>;

/** True when the api rejected the session — the client should send the user to /login. */
export function isUnauthenticatedError(error: FetchError): boolean {
	return error.kind === 'http' && error.status === 401;
}

/** True when the resource is not there, or not the caller's to see — render not-found. */
export function isNotFoundError(error: FetchError): boolean {
	return error.kind === 'http' && error.status === 404;
}

/** Who is signed in (`GET /api/me`). A 401 means "redirect to /login". */
export function getMe() {
	return httpRequest('/api/me', {method: 'GET'}, {schema: meSchema});
}

/** The welcome flow is done, or skipped: the human side opens on the app from now on. */
export function finishOnboarding() {
	return apiSend('POST', '/api/me/onboarded');
}

/**
 * Deletes the account: every connection in the organizations the person owns is undone at its
 * provider, then the user and those organizations go; the session goes with them.
 */
export function deleteAccount() {
	return apiSend('DELETE', '/api/me');
}
