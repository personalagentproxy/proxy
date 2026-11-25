import {ApiErr, type ApiError, formatFetchError} from '@proxy/utils';

import type {SlackError} from './slack-api';

/**
 * Slack's refusals in words a member can act on: what Slack said, turned into what to do next.
 * Codes Slack's reference pages list where they are; a few it may answer that the pages don't
 * list, as for a plan's app limit or an admin's approval, are matched by their likely names too.
 */

/** A configuration or bot token Slack no longer takes: revoked, run out, or its user gone. */
export const TOKEN_GONE = ['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive', 'invalid_refresh_token'];

// The token works but may not make or change apps here.
const CANT_MANAGE = ['missing_scope', 'no_permission', 'not_allowed_token_type', 'team_access_not_granted', 'invalid_manager_app', 'access_denied', 'not_in_team', 'enterprise_is_restricted'];

// The workspace's plan holds no more apps.
const PLAN_LIMIT = ['managed_app_limit_reached', 'app_limit_reached', 'too_many_apps'];

// A Slack admin has to approve the app first.
const NEEDS_APPROVAL = ['app_approval_required', 'approval_required', 'workspace_denied_app'];

/** Whether Slack turned the token down for good, so it has to be pasted, or the app installed, again. */
export function isTokenGone(error: SlackError): boolean {
	return error.kind === 'refused' && TOKEN_GONE.includes(error.error);
}

// What Slack said is wrong with the name, where it said so.
function nameProblem(error: SlackError): string | null {
	if (error.kind !== 'refused') {
		return null;
	}
	const problem = error.problems.find(({pointer}) => pointer.startsWith('/display_information/name') || pointer.startsWith('/features/bot_user/display_name'));
	return problem?.message ?? null;
}

// Whether Slack said, in a manifest's problems, that the plan holds no more apps.
function overLimit(error: SlackError): boolean {
	if (error.kind !== 'refused') {
		return false;
	}
	return PLAN_LIMIT.includes(error.error) || error.problems.some(({message}) => /\blimit\b/i.test(message));
}

/**
 * Slack's error as the member is told it, about the persona `name` and the workspace `workspace`
 * it is being added to or changed in.
 */
export function slackFailure(error: SlackError, about: {name: string; workspace: string}): ApiError {
	if (error.kind === 'rate_limited') {
		return ApiErr.providerUnreachable(error, 'Slack is limiting how often it is asked right now. Wait a minute and try again.');
	}
	if (error.kind === 'unreachable') {
		return ApiErr.providerUnreachable(formatFetchError(error.cause), 'Slack can’t be reached right now. Try again in a moment.');
	}
	const name = nameProblem(error);
	if (name !== null) {
		return ApiErr.conflict(`Slack won’t take the name ${about.name}: ${name} Rename the agent and try again.`);
	}
	if (overLimit(error)) {
		return ApiErr.conflict(`${about.workspace}’s Slack plan has no room for another app. Remove one there, or upgrade the plan, and try again.`);
	}
	if (NEEDS_APPROVAL.includes(error.error)) {
		return ApiErr.conflict(`A Slack admin of ${about.workspace} has to approve the app first. Ask one, then try again.`);
	}
	if (TOKEN_GONE.includes(error.error)) {
		return ApiErr.conflict(`Slack no longer takes the token ${about.workspace} was linked with. Paste a new one under Link a Slack workspace.`);
	}
	if (CANT_MANAGE.includes(error.error)) {
		return ApiErr.conflict(`The token ${about.workspace} was linked with can’t make apps there. Link it again with a token from someone allowed to install apps in it.`);
	}
	return ApiErr.providerUnreachable(error, `Slack turned it down (${error.error}).`);
}
