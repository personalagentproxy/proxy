import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, hasExperiment, organizationExperiments} from '@proxy/utils';
import type {SlackOpening} from '@proxy/db/harness';
import {getSlackOpeningFacts, type SlackOpeningFacts} from '@proxy/db/slack-openings';

import {log} from '../observability/log';
import {readBotToken} from './secrets';
import {openDirectMessage, type SlackError} from './slack-api';

/**
 * Where a thread one of the member's threads opens in Slack goes (native/chat/connector.ts): the
 * persona's app, and the member's DM with it, by its channel, at the top of which the app posts the
 * thread's root message (delivery.ts). Refused, in words the agent can pass on to the member, where
 * the organization hasn't Slack on, the persona isn't in Slack, or the member isn't linked to a
 * Slack user in its workspace or is no longer in the organization, as delivery's rule is
 * (delivery-rules.ts deliversTo). The DM's channel is the sending thread's, where it lives in
 * Slack with the same app; else that of another of the member's threads with the app in Slack;
 * else Slack opens it (`conversations.open`, which the app's `im:write` allows).
 */

/** What finding the DM needs: the facts read, and Slack's `conversations.open`. */
export type OpeningDeps = {facts: typeof getSlackOpeningFacts; openDm: typeof openDirectMessage};

export const openingDeps: OpeningDeps = {facts: getSlackOpeningFacts, openDm: openDirectMessage};

// What a thread can be opened in Slack with, as the facts say, before the DM is looked for: the
// app, with its bot's token, and the member's Slack user; or why it can't, in the agent's words.
type Openable = {app: {id: string; botToken: string}; slackUserId: string; knownChannel: string | null};

function openable(facts: SlackOpeningFacts | null, persona: {name: string}): Result<Openable, ApiError> {
	if (facts === null || !hasExperiment({experiments: organizationExperiments(facts.org)}, 'slack')) {
		return Err(ApiErr.validationError('Slack isn’t on for your organization, so a thread can’t be opened there'));
	}
	const {app, slackUserId, knownChannel} = facts;
	if (app === null || app.removedAt !== null || app.botToken === null) {
		return Err(ApiErr.validationError(`${persona.name} isn’t in Slack, so a thread with it can’t be opened there; whoever manages it can add it to Slack from its settings`));
	}
	if (!facts.inOrganization) {
		return Err(ApiErr.validationError('You’re no longer in this organization'));
	}
	if (slackUserId === null) {
		return Err(ApiErr.validationError(`You aren’t linked to Slack in ${persona.name}’s workspace yet: write to ${persona.name} in Slack once and confirm who you are, then ask again`));
	}
	return Ok({app: {id: app.id, botToken: app.botToken}, slackUserId, knownChannel});
}

// Slack's no to opening the DM, in the agent's words.
function openFailure(error: SlackError, persona: {name: string}): ApiError {
	if (error.kind === 'refused') {
		return ApiErr.validationError(`Slack wouldn’t open your direct messages with ${persona.name} (${error.error}), so the thread wasn’t opened`);
	}
	return ApiErr.providerUnreachable(error, 'Slack can’t be reached right now, so the thread wasn’t opened. Try again in a moment.');
}

/** Where in Slack a thread with the persona goes, opened by the member's thread that lives at `from` in Slack, or in the app (null). */
export function slackOpening(
	member: {orgId: string; userId: string},
	persona: {id: string; name: string},
	from: SlackOpening | null,
	deps: OpeningDeps = openingDeps,
): Promise<Result<SlackOpening, ApiError>> {
	return Do(async ($) => {
		const {app, slackUserId, knownChannel} = $(openable($(await deps.facts(member, persona.id)), persona));
		if (from !== null && from.appId === app.id) {
			return {appId: app.id, channel: from.channel};
		}
		if (knownChannel !== null) {
			return {appId: app.id, channel: knownChannel};
		}
		const token = $(readBotToken(app.botToken));
		const opened = await deps.openDm(token, slackUserId);
		if (opened.isErr()) {
			log.warn('Slack would not open a member’s DM with a persona’s app', {appId: app.id, kind: opened.error.kind, ...(opened.error.kind === 'refused' ? {error: opened.error.error} : {})});
			return $(Err(openFailure(opened.error, persona)));
		}
		return {appId: app.id, channel: opened.value};
	});
}
