import {
	authorizationRequestSchema,
	consentAnswerSchema,
	type Consent,
	type consentBodySchema,
} from '@proxy/contracts/oauth';
import type {z} from 'zod';
import {apiRequest} from '@/client/request';

// Connecting an MCP client, such as Claude, as one of the person's agents: the api checked the
// client's request and sealed it into the consent page's address.

export function getAuthorizationRequest(request: string) {
	return apiRequest(
		'GET',
		`/api/oauth/request?${new URLSearchParams({request})}`,
		authorizationRequestSchema,
	);
}

/** The person's answer to the sealed `request`: where to go next. */
export function answerAuthorizationRequest(request: string, consent: Consent) {
	return apiRequest('POST', '/api/oauth/consent', consentAnswerSchema, {
		request,
		...consent,
	} satisfies z.input<typeof consentBodySchema>);
}
