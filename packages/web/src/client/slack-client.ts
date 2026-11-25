import {
	linkedSlackWorkspaceSchema,
	personaInSlackSchema,
	personaSlackSchema,
	slackAppAnswerSchema,
	slackConfirmationSchema,
	slackConfirmedSchema,
	slackMemberLinksSchema,
} from '@proxy/contracts/slack';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Slack, for an organization with the `slack` experiment on: the workspaces linked to it, and a
// shared persona's own Slack app in one of them; and the person's Slack accounts linked to them.

function personaSlack(org: string, personaId: string): string {
	return `${orgApi(org)}/chat/personas/${encodeURIComponent(personaId)}/slack`;
}

/** The persona's app, the workspaces it can be added to, and why it can't be here, where it can't. */
export function getPersonaSlack(org: string, personaId: string) {
	return apiRequest('GET', personaSlack(org, personaId), personaSlackSchema);
}

/** Where any member who sees the persona writes to it in Slack, once it is installed there. */
export function getPersonaInSlack(org: string, personaId: string) {
	return apiRequest('GET', `${personaSlack(org, personaId)}/presence`, personaInSlackSchema);
}

/** Links a workspace with an app configuration token and its refresh token, or gives a linked one new ones. */
export function linkSlackWorkspace(org: string, tokens: {token: string; refreshToken: string}) {
	return apiRequest('POST', `${orgApi(org)}/slack/workspaces`, linkedSlackWorkspaceSchema, tokens);
}

export function unlinkSlackWorkspace(org: string, workspaceId: string) {
	return apiSend('DELETE', `${orgApi(org)}/slack/workspaces/${encodeURIComponent(workspaceId)}`);
}

/** Makes the persona's app in the workspace; the person installs it next (`slackInstallPath`). */
export function addToSlack(org: string, personaId: string, workspaceId: string) {
	return apiRequest('POST', personaSlack(org, personaId), slackAppAnswerSchema, {workspaceId});
}

/** Updates the app's manifest in Slack to ours as it is now. */
export function updateSlackApp(org: string, personaId: string) {
	return apiRequest('POST', `${personaSlack(org, personaId)}/update`, slackAppAnswerSchema);
}

/** Deletes the app in Slack and forgets it here. */
export function removeSlackApp(org: string, personaId: string) {
	return apiSend('DELETE', personaSlack(org, personaId));
}

/** Forgets the app here alone, where Slack can't delete it. */
export function forgetSlackApp(org: string, personaId: string) {
	return apiSend('POST', `${personaSlack(org, personaId)}/forget`);
}

/** Where the browser goes to install the app through Slack, a page of its own. */
export function slackInstallPath(org: string, personaId: string): string {
	return `${personaSlack(org, personaId)}/install`;
}

function slackLink(token: string): string {
	return `/api/slack-links/${encodeURIComponent(token)}`;
}

/** What a link from a persona's app in Slack is for, as the person signed in sees it. */
export function getSlackLink(token: string) {
	return apiRequest('GET', slackLink(token), slackConfirmationSchema);
}

/** Links the Slack user to the person signed in; the message that prompted it is taken up. */
export function confirmSlackLink(token: string) {
	return apiRequest('POST', slackLink(token), slackConfirmedSchema);
}

/** The Slack users the person is linked to, in every organization. */
export function listSlackLinks() {
	return apiRequest('GET', '/api/me/slack-links', slackMemberLinksSchema);
}

export function unlinkSlackLink(linkId: string) {
	return apiSend('DELETE', `/api/me/slack-links/${encodeURIComponent(linkId)}`);
}
