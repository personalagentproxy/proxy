import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * What opening a thread in Slack from another of the member's threads rests on (api
 * slack/openings.ts): whether the organization has Slack on, the persona's app, whether the member
 * is linked to a Slack user in its workspace and is still in the organization, and the DM's
 * channel where it is known already, from a thread of theirs with the app that lives in Slack.
 */
export type SlackOpeningFacts = {
	org: {experiments: string[]; insider: boolean};
	app: {id: string; botToken: string | null; removedAt: Date | null} | null;
	// The Slack user the member is linked to in the app's workspace; null for none.
	slackUserId: string | null;
	inOrganization: boolean;
	knownChannel: string | null;
};

/** What opening a thread in Slack with the persona rests on, for the member; `Ok(null)` for no such organization. */
export async function getSlackOpeningFacts(
	member: {orgId: string; userId: string},
	personaId: string,
): Promise<Result<SlackOpeningFacts | null, ApiError>> {
	return wrapDb(async () => {
		const org = await db.organization.findUnique({
			where: {id: member.orgId},
			select: {experiments: true, insider: true},
		});
		if (org === null) {
			return null;
		}
		const inOrganization = (await db.orgMember.count({where: member})) > 0;
		const app = await db.slackApp.findFirst({
			where: {personaId, orgId: member.orgId},
			select: {id: true, botToken: true, removedAt: true, workspaceId: true},
		});
		if (app === null) {
			return {org, app: null, slackUserId: null, inOrganization, knownChannel: null};
		}
		const link = await db.slackMemberLink.findFirst({
			where: {...member, workspaceId: app.workspaceId},
			select: {slackUserId: true},
		});
		// The member's DM with the app is one channel, which each of their threads there is in.
		const known = await db.slackThreadPlace.findFirst({
			where: {appId: app.id, rootTs: {not: null}, stoppedAt: null, thread: member},
			select: {channel: true},
			orderBy: {createdAt: 'desc'},
		});
		return {
			org,
			app: {id: app.id, botToken: app.botToken, removedAt: app.removedAt},
			slackUserId: link?.slackUserId ?? null,
			inOrganization,
			knownChannel: known?.channel ?? null,
		};
	});
}
