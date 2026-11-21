import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, hasExperiment, organizationExperiments} from '@proxy/utils';
import type {SlackConfirmation, SlackConfirmed, SlackMemberLink} from '@proxy/contracts/slack';
import {getMembership} from '@proxy/db/organization';
import {getSlackAppForLink, getSlackMember, linkSlackMember, listSlackMemberLinks, type SlackAppForLink, unlinkSlackMember} from '@proxy/db/slack-messages';

import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {type ConfirmClaims, readConfirmToken} from './confirm-link';
import {readSlackMessage} from './message-rules';
import {postSlackLines, takeUpSlackMessageFrom} from './messages';
import {readBotToken} from './secrets';
import {readMessage, slackAppUrl} from './slack-api';

/**
 * Confirming who a Slack user is, from the link a persona's app gave them (confirm-link.ts), on
 * the web app's `/confirm-slack/<token>` page, signed in: what the link is for, and confirming
 * it, which links the Slack user to the person signed in, a member of the app's organization, for
 * the organization's workspace, then reads the message that prompted it back from Slack and takes
 * it up, as if it had just come. And the person's links, on their account, each to unlink.
 */

// The link in the address, read: its claims and its app, in an organization with the `slack`
// experiment, in the workspace the link names; null for one that has run out. Not found for
// anything else, as for a link that isn't one.
function readLink(request: AuthenticatedRequest): Promise<Result<{claims: ConfirmClaims; app: SlackAppForLink} | null, ApiError>> {
	return Do(async ($) => {
		const notFound = ApiErr.notFound('Slack link');
		if (!env.AUTH_SECRET) {
			return $(Err(notFound));
		}
		const read = readConfirmToken(request.params.token ?? '', env.AUTH_SECRET);
		if (read.isErr()) {
			return read.error === 'expired' ? null : $(Err(notFound));
		}
		const claims = read.value;
		const app = $(await getSlackAppForLink(claims.appId));
		if (!app || app.workspace.teamId !== claims.teamId || !hasExperiment({experiments: organizationExperiments(app.org)}, 'slack')) {
			return $(Err(notFound));
		}
		return {claims, app};
	});
}

/** `GET /api/slack-links/:token`: what the link is for, as the person signed in sees it (`SlackConfirmation`). */
export function handleGetSlackLinkRoute(request: AuthenticatedRequest): Promise<Result<SlackConfirmation, ApiError>> {
	return Do(async ($): Promise<SlackConfirmation> => {
		const link = $(await readLink(request));
		if (link === null) {
			return {state: 'expired'};
		}
		const {claims, app} = link;
		const about = {workspaceName: app.workspace.name, orgName: app.org.name};
		if ($(await getMembership(request.user.userId, app.orgId)) === null) {
			return {state: 'not_member', ...about, ownerName: app.org.owner.name};
		}
		const member = $(await getSlackMember(app.workspaceId, claims.slackUserId));
		if (member !== null && member.userId !== request.user.userId) {
			return {state: 'taken', ...about};
		}
		return {state: 'confirm', ...about, personaName: app.persona.name, linked: member !== null};
	});
}

// The message that prompted the link, read back from Slack and taken up as if it had just come,
// its lines said after; whether it is in a thread now. A failure to read it is logged: the member
// writes it again.
async function takeUpPrompting(app: SlackAppForLink, claims: ConfirmClaims, userId: string): Promise<boolean> {
	const token = app.botToken === null || app.removedAt !== null ? null : readBotToken(app.botToken).unwrapOr(null);
	if (token === null) {
		return false;
	}
	const read = await readMessage(token, {channel: claims.channel, ts: claims.ts});
	if (read.isErr()) {
		log.warn('A Slack message could not be read back', {appId: app.id, kind: read.error.kind, ...(read.error.kind === 'refused' ? {error: read.error.error} : {})});
		return false;
	}
	const said = read.value === null ? null : readSlackMessage(read.value, {channel: claims.channel, channelType: 'im', botUserId: app.botUserId});
	if (said === null || said.slackUserId !== claims.slackUserId) {
		return false;
	}
	const outcome = await takeUpSlackMessageFrom(app, said, {kind: 'member', userId});
	void postSlackLines(app, outcome.lines);
	return outcome.takenUp;
}

/**
 * `POST /api/slack-links/:token`: the Slack user linked to the person signed in, a member of the
 * app's organization, for its workspace, where they are linked to nobody else; then the message
 * that prompted it taken up. Refused for a link that has run out, for someone not in the
 * organization, and where the Slack user is another member's.
 */
export function handleConfirmSlackLinkRoute(request: AuthenticatedRequest): Promise<Result<SlackConfirmed, ApiError>> {
	return Do(async ($) => {
		const link = $(await readLink(request));
		if (link === null) {
			return $(Err(ApiErr.validationError('This link has run out. Write in Slack again for a new one.')));
		}
		const {claims, app} = link;
		if ($(await getMembership(request.user.userId, app.orgId)) === null) {
			return $(Err(ApiErr.forbidden()));
		}
		const linking = $(await linkSlackMember({orgId: app.orgId, workspaceId: app.workspaceId, slackUserId: claims.slackUserId, userId: request.user.userId}));
		if (linking === 'other') {
			return $(Err(ApiErr.conflict(`This Slack account is linked to someone else in ${app.org.name}. They can unlink it from their account.`)));
		}
		const takenUp = await takeUpPrompting(app, claims, request.user.userId);
		return {personaName: app.persona.name, takenUp, slackUrl: slackAppUrl(app.slackAppId ?? '', app.workspace.teamId)};
	});
}

/** `GET /api/me/slack-links`: the Slack users the person is linked to, in every organization. */
export function handleListSlackLinksRoute(request: AuthenticatedRequest): Promise<Result<{links: SlackMemberLink[]}, ApiError>> {
	return Do(async ($) => {
		const links = $(await listSlackMemberLinks(request.user.userId));
		return {links: links.map(({id, workspaceName, orgName, createdAt}) => ({id, workspaceName, orgName, createdAt: createdAt.toISOString()}))};
	});
}

/** `DELETE /api/me/slack-links/:linkId`: one of the person's links unlinked; their next message in Slack asks them to confirm who they are again. */
export function handleUnlinkSlackLinkRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const linkId = request.params.linkId ?? '';
		if (!$(await unlinkSlackMember(request.user.userId, linkId))) {
			return $(Err(ApiErr.notFound('Slack link', linkId)));
		}
	});
}
