import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema} from '@proxy/utils';
import {addToSlackBodySchema, linkSlackWorkspaceBodySchema, type PersonaInSlack, type PersonaSlack, type SlackApp, type SlackAppState, type SlackWorkspace} from '@proxy/contracts/slack';
import {getPersona, type PersonaRow} from '@proxy/db/harness';
import {
	finishSlackApp,
	forgetSlackApp,
	getPersonaSlackApp,
	getSlackWorkspace,
	linkSlackWorkspace,
	listSlackWorkspaces,
	markSlackAppRemoved,
	type SlackAppRow,
	type SlackWorkspaceRow,
	startSlackApp,
	unlinkSlackWorkspace,
	updateSlackAppManifest,
} from '@proxy/db/slack';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {manages} from '../utils/manages';
import {encryptSecret} from '../utils/secret-crypto';
import {requireViewer, type OrgViewer} from '../utils/user-org';
import {SLACK_BOT_SCOPES, SLACK_MANIFEST_VERSION, slackManifest} from './manifest';
import {createApp, deleteApp, rotateConfigurationToken, type SlackError, slackAppUrl, testToken, updateApp} from './slack-api';
import {isTokenGone, slackFailure} from './slack-errors';
import {readBotToken} from './secrets';
import {keptRotation, withWorkspaceToken} from './workspace-token';

/**
 * Slack's routes in the organization, for one with the `slack` experiment on: linking a Slack
 * workspace with an app configuration token, and adding a shared persona to a linked one as a
 * Slack app of its own, made from our manifest (manifest.ts), which the member then installs
 * through Slack (install.ts); updating it where our manifest has moved on, or the persona was
 * renamed; and removing it, which deletes it in Slack, or only forgetting it here where Slack
 * can't do that. Whoever may change the persona adds, updates and removes its app; any member
 * links and unlinks a workspace.
 */

// The experiment, and the viewer as the routes have them.
function requireSlack(viewer: OrgViewer): Result<OrgViewer, ApiError> {
	return hasExperiment(viewer, 'slack') ? Ok(viewer) : Err(ApiErr.forbidden());
}

function requireSlackViewer(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => $(requireSlack($(await requireViewer(request)))));
}

/** Why no persona can be added to Slack from this server, as the page says it: Slack only calls https addresses. Null where it can. */
export function slackUnavailable(): string | null {
	const appUrl = env.APP_URL ?? '';
	if (appUrl.startsWith('https://')) {
		return null;
	}
	return `Slack only sends to https addresses, and this Personal Agent Proxy is at ${appUrl || 'no address'} (APP_URL). Set APP_URL to its https address to add agents to Slack.`;
}

/** The persona in the address, one the viewer sees and may change: another member's own is not found, and one they only use is forbidden. */
export function requireManagedPersona(viewer: OrgViewer, personaId: string): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const persona = $(await getPersona(viewer.orgId, viewer.userId, personaId));
		if (!persona) {
			return $(Err(ApiErr.notFound('persona', personaId)));
		}
		if (!manages(viewer, {ownerUserId: persona.ownerUserId, byId: persona.createdById})) {
			return $(Err(ApiErr.forbidden()));
		}
		return persona;
	});
}

/** Where the persona's app stands (`SlackAppState`). */
export function slackAppState(app: SlackAppRow, persona: {name: string}): SlackAppState {
	if (app.removedAt !== null) {
		return 'removed';
	}
	if (app.botToken === null) {
		return 'waiting';
	}
	const missing = SLACK_BOT_SCOPES.some((scope) => !app.scopes.includes(scope));
	if (app.manifestVersion < SLACK_MANIFEST_VERSION || app.manifestName !== persona.name.trim() || missing) {
		return 'out_of_date';
	}
	return 'in_slack';
}

function toSlackApp(app: SlackAppRow, persona: {name: string}, workspace: {name: string}): SlackApp {
	return {
		state: slackAppState(app, persona),
		workspaceId: app.workspaceId,
		workspaceName: workspace.name,
		handle: app.botName,
		settingsUrl: app.slackAppId === null ? null : `https://api.slack.com/apps/${app.slackAppId}/general`,
	};
}

function toSlackWorkspace(workspace: SlackWorkspaceRow & {apps: number}): SlackWorkspace {
	return {id: workspace.id, name: workspace.name, needsToken: workspace.refusedAt !== null, inUse: workspace.apps > 0};
}

// The workspace the app is in, which can't be unlinked while it is.
function requireWorkspace(viewer: OrgViewer, workspaceId: string): Promise<Result<SlackWorkspaceRow, ApiError>> {
	return Do(async ($) => {
		const workspace = $(await getSlackWorkspace(viewer.orgId, workspaceId));
		if (!workspace) {
			return $(Err(ApiErr.notFound('Slack workspace', workspaceId)));
		}
		return workspace;
	});
}

// The persona's app, where it has one.
function requireApp(persona: PersonaRow): Promise<Result<SlackAppRow, ApiError>> {
	return Do(async ($) => {
		const app = $(await getPersonaSlackApp(persona.id));
		if (!app) {
			return $(Err(ApiErr.notFound('Slack app', persona.id)));
		}
		return app;
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/slack`: the persona's app, and the workspaces it can be added to. */
export function handlePersonaSlackRoute(request: AuthenticatedRequest): Promise<Result<PersonaSlack, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		const workspaces = $(await listSlackWorkspaces(viewer.orgId));
		const app = $(await getPersonaSlackApp(persona.id));
		const workspace = app === null ? undefined : workspaces.find(({id}) => id === app.workspaceId);
		return {
			workspaces: workspaces.map(toSlackWorkspace),
			app: app === null || workspace === undefined ? null : toSlackApp(app, persona, workspace),
			unavailable: slackUnavailable(),
		};
	});
}

/**
 * `GET /api/orgs/:org/chat/personas/:personaId/slack/presence`: where any member who sees the
 * persona writes to it in Slack, as its settings say to one who may not change it: its handle, its
 * workspace and the address of its messages there, once it is installed and until it is removed.
 */
export function handlePersonaInSlackRoute(request: AuthenticatedRequest): Promise<Result<PersonaInSlack, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const personaId = request.params.personaId ?? '';
		const persona = $(await getPersona(viewer.orgId, viewer.userId, personaId));
		if (!persona) {
			return $(Err(ApiErr.notFound('persona', personaId)));
		}
		const app = $(await getPersonaSlackApp(persona.id));
		if (app === null || app.slackAppId === null || app.botName === null) {
			return {inSlack: null};
		}
		const state = slackAppState(app, persona);
		if (state !== 'in_slack' && state !== 'out_of_date') {
			return {inSlack: null};
		}
		const workspace = $(await getSlackWorkspace(viewer.orgId, app.workspaceId));
		if (workspace === null) {
			return {inSlack: null};
		}
		return {inSlack: {handle: app.botName, workspaceName: workspace.name, slackUrl: slackAppUrl(app.slackAppId, workspace.teamId)}};
	});
}

/**
 * `POST /api/orgs/:org/slack/workspaces` with `{token, refreshToken}`: a Slack workspace linked to
 * the organization. The refresh token is rotated at once, which proves the pair works and says
 * whose workspace and Slack user it is; the new pair is kept, encrypted. Linking one linked
 * already gives it the new token, as one Slack turned down needs.
 */
export function handleLinkSlackWorkspaceRoute(request: AuthenticatedRequest): Promise<Result<{workspace: SlackWorkspace}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const {refreshToken} = $(parseSchema(linkSlackWorkspaceBodySchema, request.body));
		const rotated = await rotateConfigurationToken(refreshToken);
		if (rotated.isErr()) {
			return $(Err(linkFailure(rotated.error)));
		}
		const kept = $(keptRotation(rotated.value));
		// The workspace's name; its id where Slack won't say, until an install says it.
		const identity = await testToken(rotated.value.token);
		const name = identity.isOk() && identity.value.team !== '' ? identity.value.team : rotated.value.teamId;
		const workspace = $(await linkSlackWorkspace({orgId: viewer.orgId, teamId: rotated.value.teamId, name, slackUserId: rotated.value.userId, linkedById: viewer.userId, ...kept}));
		const listed = $(await listSlackWorkspaces(viewer.orgId)).find(({id}) => id === workspace.id);
		return {workspace: toSlackWorkspace(listed ?? {...workspace, apps: 0})};
	});
}

// What linking says where the pasted tokens didn't rotate.
function linkFailure(error: SlackError): ApiError {
	if (error.kind === 'refused' && (isTokenGone(error) || error.error === 'invalid_arguments')) {
		return ApiErr.validationError('Slack didn’t take that refresh token. Generate a new pair and paste both.');
	}
	return slackFailure(error, {name: 'the agent', workspace: 'The workspace'});
}

/** `DELETE /api/orgs/:org/slack/workspaces/:workspaceId`: the workspace unlinked, refused while a persona's app is in it. */
export function handleUnlinkSlackWorkspaceRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const workspaceId = request.params.workspaceId ?? '';
		const unlinked = $(await unlinkSlackWorkspace(viewer.orgId, workspaceId));
		if (unlinked === 'missing') {
			return $(Err(ApiErr.notFound('Slack workspace', workspaceId)));
		}
		if (unlinked === 'in_use') {
			return $(Err(ApiErr.conflict('An agent is in this workspace. Remove it from Slack first.')));
		}
	});
}

/**
 * `POST /api/orgs/:org/chat/personas/:personaId/slack` with `{workspaceId}`: the persona added to
 * a linked workspace as a Slack app of its own. The row comes first, since the address its events
 * go to names it, then Slack makes the app from the manifest, and its id, client and secrets are
 * kept; where Slack refuses, the row goes again. The member installs it next (install.ts).
 */
export function handleAddToSlackRoute(request: AuthenticatedRequest): Promise<Result<{app: SlackApp; install: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		const {workspaceId} = $(parseSchema(addToSlackBodySchema, request.body));
		if (persona.ownerUserId !== null) {
			return $(Err(ApiErr.conflict(`Share ${persona.name} with everyone in ${viewer.name} first: only a shared agent can be added to Slack.`)));
		}
		const unavailable = slackUnavailable();
		if (unavailable !== null) {
			return $(Err(ApiErr.conflict(unavailable)));
		}
		const workspace = $(await requireWorkspace(viewer, workspaceId));
		const name = persona.name.trim();
		const started = $(await startSlackApp({orgId: viewer.orgId, personaId: persona.id, workspaceId, manifestVersion: SLACK_MANIFEST_VERSION, manifestName: name, addedById: viewer.userId}));
		if (started.kind === 'not_shared') {
			return $(Err(ApiErr.conflict(`Share ${persona.name} with everyone in ${viewer.name} first: only a shared agent can be added to Slack.`)));
		}
		if (started.kind === 'exists') {
			return $(Err(ApiErr.conflict(`${persona.name} is in Slack already.`)));
		}
		if (started.kind === 'no_workspace') {
			return $(Err(ApiErr.notFound('Slack workspace', workspaceId)));
		}
		const manifest = slackManifest({appId: started.app.id, personaName: name, orgName: viewer.name, appUrl: env.APP_URL ?? ''});
		const created = await withWorkspaceToken(
			workspace,
			(token) => createApp(token, manifest),
			(error) => slackFailure(error, {name, workspace: workspace.name}),
		);
		if (created.isErr()) {
			$(await forgetSlackApp(started.app.id));
			return $(Err(created.error));
		}
		const {appId, clientId, clientSecret, signingSecret} = created.value;
		const secrets = $(encryptSecret(JSON.stringify({clientSecret, signingSecret})));
		const app = $(await finishSlackApp(started.app.id, {slackAppId: appId, clientId, secrets}));
		return {app: toSlackApp(app, persona, workspace), install: true};
	});
}

// Whether the bot's token still works, where there is one: one Slack no longer takes is the app
// removed there, which is marked so.
function checkStillInSlack(app: SlackAppRow): Promise<Result<SlackAppRow, ApiError>> {
	return Do(async ($) => {
		if (app.botToken === null || app.removedAt !== null) {
			return app;
		}
		const tested = await testToken($(readBotToken(app.botToken)));
		if (tested.isErr() && isTokenGone(tested.error)) {
			$(await markSlackAppRemoved(app.id));
			return {...app, removedAt: new Date(), botToken: null};
		}
		return app;
	});
}

/**
 * `POST /api/orgs/:org/chat/personas/:personaId/slack/update`: the app's manifest replaced in
 * place with ours as it is now, with the persona's name as it is now. Where the app was granted
 * less than it now asks for, the member goes through Slack's install again (`install`), which is
 * how Slack grants new scopes.
 */
export function handleUpdateSlackAppRoute(request: AuthenticatedRequest): Promise<Result<{app: SlackApp; install: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		const existing = $(await requireApp(persona));
		const workspace = $(await requireWorkspace(viewer, existing.workspaceId));
		if (existing.slackAppId === null) {
			return $(Err(ApiErr.conflict(`Slack hasn’t finished making ${persona.name}’s app. Try again in a moment.`)));
		}
		const unavailable = slackUnavailable();
		if (unavailable !== null) {
			return $(Err(ApiErr.conflict(unavailable)));
		}
		const name = persona.name.trim();
		const slackAppId = existing.slackAppId;
		const manifest = slackManifest({appId: existing.id, personaName: name, orgName: viewer.name, appUrl: env.APP_URL ?? ''});
		$(
			await withWorkspaceToken(
				workspace,
				(token) => updateApp(token, slackAppId, manifest),
				(error) => slackFailure(error, {name, workspace: workspace.name}),
			),
		);
		const updated = $(await checkStillInSlack($(await updateSlackAppManifest(existing.id, {manifestVersion: SLACK_MANIFEST_VERSION, manifestName: name}))));
		const missing = SLACK_BOT_SCOPES.some((scope) => !updated.scopes.includes(scope));
		return {app: toSlackApp(updated, persona, workspace), install: updated.removedAt === null && missing};
	});
}

/**
 * The persona's app deleted in Slack, which uninstalls it there, and forgotten here. One Slack has
 * no more counts as deleted. Where Slack can't be reached or won't take the workspace's token,
 * nothing is forgotten, and the failure says why; forgetting it here alone is the member's choice.
 */
export function removeSlackApp(viewer: OrgViewer, persona: PersonaRow): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const app = $(await getPersonaSlackApp(persona.id));
		if (!app) {
			return;
		}
		const slackAppId = app.slackAppId;
		if (slackAppId !== null) {
			const workspace = $(await requireWorkspace(viewer, app.workspaceId));
			$(
				await withWorkspaceToken(
					workspace,
					async (token) => {
						const deleted = await deleteApp(token, slackAppId);
						return deleted.isErr() && deleted.error.kind === 'refused' && deleted.error.error === 'app_not_found' ? Ok(undefined) : deleted;
					},
					(error) => slackFailure(error, {name: persona.name, workspace: workspace.name}),
				),
			);
		}
		$(await forgetSlackApp(app.id));
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId/slack`: the persona's app deleted in Slack and forgotten here (`removeSlackApp`). */
export function handleRemoveSlackAppRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		$(await requireApp(persona));
		$(await removeSlackApp(viewer, persona));
	});
}

/**
 * `POST /api/orgs/:org/chat/personas/:personaId/slack/forget`: the persona's app forgotten here
 * without asking Slack, for when Slack can't delete it: it may stay in Slack, for an admin there to
 * delete.
 */
export function handleForgetSlackAppRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireSlackViewer(request));
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		const app = $(await requireApp(persona));
		$(await forgetSlackApp(app.id));
	});
}
