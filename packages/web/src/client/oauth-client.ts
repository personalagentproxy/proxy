import {z} from 'zod';
import {apiRequest} from '@/client/request';

// Connecting an MCP client, such as Claude, as one of the person's agents: the api checked the
// client's request and sealed it into the consent page's address.

const authorizationRequestSchema = z.object({
	clientName: z.string(),
	redirectHost: z.string(),
	suggestedProviderId: z.string().nullable(),
});

export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

export function getAuthorizationRequest(request: string) {
	return apiRequest(
		'GET',
		`/api/oauth/request?${new URLSearchParams({request})}`,
		authorizationRequestSchema,
	);
}

/** The person's answer, as an existing agent or a new login for a provider: where to go next. */
export type Consent =
	{allow: false} | {allow: true; agentId: string} | {allow: true; providerId: string};

export function answerAuthorizationRequest(request: string, consent: Consent) {
	return apiRequest('POST', '/api/oauth/consent', z.object({redirectTo: z.string()}), {
		request,
		...consent,
	});
}
