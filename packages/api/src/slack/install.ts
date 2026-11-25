import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseCookieHeader, requirePresent} from '@proxy/utils';
import type {SlackInstallOutcome} from '@proxy/contracts/slack';
import {getMembership} from '@proxy/db/organization';
import {getPersonaSlackApp, getSlackWorkspace, installSlackApp} from '@proxy/db/slack';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../auth/session';
import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {requireViewer} from '../utils/user-org';
import {SLACK_BOT_SCOPES} from './manifest';
import {requireManagedPersona} from './route';
import {readAppSecrets} from './secrets';
import {exchangeInstallCode, testToken} from './slack-api';

/**
 * Installing a persona's Slack app in its workspace with Slack's OAuth v2 install
 * (https://docs.slack.dev/authentication/installing-with-oauth), as connecting GitHub signs in:
 * the start, a top-level navigation from the persona's dialog, keeps a state value in a short-lived
 * encrypted cookie and sends the browser to Slack's install page for the app; Slack comes back to
 * `<APP_URL>/slack/install`, the redirect address in the app's manifest, where the state is checked
 * against the cookie, the code traded for the bot's token, and the install checked: in the
 * workspace the app was made in, and not across a whole Enterprise organization, which is refused.
 * Where the workspace has a Slack admin approve apps first, Slack sends the member nowhere back:
 * the app stays waiting, and once it is approved the member starts the install again. Either way
 * the browser ends on the persona's chat, `?slack=` saying how it went (`SlackInstallOutcome`).
 */

const STATE_COOKIE = 'proxy.slack-install-state';
// Only sent back to the return.
const RETURN_PATH = '/slack/install';
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

const statePayloadSchema = z.object({state: z.string(), userId: z.string(), orgId: z.string(), slug: z.string(), personaId: z.string(), appId: z.string()});

type StatePayload = z.infer<typeof statePayloadSchema>;

function cookieOptions() {
	return {httpOnly: true, sameSite: 'lax' as const, secure: useSecureCookies(), path: RETURN_PATH};
}

/** Where Slack's install comes back to, in every app's manifest. */
export function slackRedirectUri(appUrl: string): string {
	return `${appUrl}${RETURN_PATH}`;
}

function chatPath(slug: string, personaId: string): string {
	return `/${encodeURIComponent(slug)}/chat/${encodeURIComponent(personaId)}`;
}

// Slack's install page for the app, in its workspace, coming back with `state`.
function installUrl(args: {clientId: string; teamId: string; appUrl: string; state: string}): string {
	const url = new URL('https://slack.com/oauth/v2/authorize');
	url.searchParams.set('client_id', args.clientId);
	url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
	url.searchParams.set('redirect_uri', slackRedirectUri(args.appUrl));
	url.searchParams.set('state', args.state);
	url.searchParams.set('team', args.teamId);
	return url.toString();
}

// The handshake kept in the cookie, and Slack's install page to send the browser to.
function beginInstall(request: AuthenticatedRequest, appUrl: string): Promise<Result<{url: string; cookie: string}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (!hasExperiment(viewer, 'slack')) {
			return $(Err(ApiErr.forbidden()));
		}
		const persona = $(await requireManagedPersona(viewer, request.params.personaId ?? ''));
		const app = $(requirePresent($(await getPersonaSlackApp(persona.id)), ApiErr.notFound('Slack app', persona.id)));
		const clientId = $(requirePresent(app.clientId, ApiErr.conflict('Slack hasn’t finished making the app.')));
		const workspace = $(requirePresent($(await getSlackWorkspace(viewer.orgId, app.workspaceId)), ApiErr.notFound('Slack workspace', app.workspaceId)));
		const state = randomBytes(16).toString('hex');
		const payload: StatePayload = {state, userId: viewer.userId, orgId: viewer.orgId, slug: viewer.slug, personaId: persona.id, appId: app.id};
		const cookie = $(encryptSecret(JSON.stringify(payload)));
		return {url: installUrl({clientId, teamId: workspace.teamId, appUrl, state}), cookie};
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/slack/install`: sends the browser to Slack's install page for the persona's app. */
export async function handleStartSlackInstallRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const appUrl = env.APP_URL;
	if (!appUrl) {
		res.status(500).json({error: 'app_url_not_configured'});
		return;
	}
	const begun = await beginInstall(request, appUrl);
	if (begun.isErr()) {
		log.warn('Installing a Slack app could not begin', {kind: begun.error.kind, ...('cause' in begun.error ? serializeError(begun.error.cause) : {})});
		res.redirect(`${appUrl}${chatPath(request.params.org ?? '', request.params.personaId ?? '')}?slack=failed`);
		return;
	}
	res.cookie(STATE_COOKIE, begun.value.cookie, {...cookieOptions(), maxAge: STATE_MAX_AGE_MS});
	res.redirect(begun.value.url);
}

// The install checked against the cookie and traded for the bot's token, then checked and kept.
function finishInstall(request: AuthenticatedRequest, appUrl: string, payload: StatePayload): Promise<Result<SlackInstallOutcome, ApiError>> {
	return Do(async ($) => {
		const state = queryParam(request, 'state') ?? '';
		if (!timingSafeEqualString(state, payload.state) || payload.userId !== request.user.userId) {
			return $(Err(ApiErr.validationError('Slack install state does not match')));
		}
		const refused = queryParam(request, 'error');
		if (refused !== null) {
			return refused === 'access_denied' ? 'denied' : $(Err(ApiErr.validationError(`Slack install ended with ${refused}`)));
		}
		const code = $(requirePresent(queryParam(request, 'code'), ApiErr.validationError('Slack install ended without a code')));
		$(requirePresent($(await getMembership(payload.userId, payload.orgId)), ApiErr.notFound('organization', payload.slug)));
		const app = $(await getPersonaSlackApp(payload.personaId));
		if (!app || app.id !== payload.appId || app.clientId === null || app.secrets === null) {
			return $(Err(ApiErr.notFound('Slack app', payload.appId)));
		}
		const {clientSecret} = $(readAppSecrets(app.secrets));
		const installed = $((await exchangeInstallCode({clientId: app.clientId, clientSecret}, {code, redirectUri: slackRedirectUri(appUrl)})).mapErr((error) => ApiErr.providerUnreachable(error)));
		if (installed.enterprise) {
			return 'enterprise';
		}
		const workspace = $(requirePresent($(await getSlackWorkspace(payload.orgId, app.workspaceId)), ApiErr.notFound('Slack workspace', app.workspaceId)));
		if (installed.team === null || installed.team.id !== workspace.teamId) {
			return 'workspace';
		}
		if (installed.appId !== app.slackAppId) {
			return $(Err(ApiErr.validationError('Slack installed another app')));
		}
		// The bot's handle, which the page shows; the install stands without it.
		const identity = await testToken(installed.botToken);
		const botToken = $(encryptSecret(installed.botToken));
		$(
			await installSlackApp(app.id, {
				botToken,
				botUserId: installed.botUserId,
				botName: identity.isOk() ? identity.value.user : null,
				scopes: installed.scopes,
				workspaceName: installed.team.name || workspace.name,
			}),
		);
		return 'installed';
	});
}

/** `GET /slack/install`: where Slack's install comes back to; ends on the persona's chat, saying how it went. */
export async function handleSlackInstallCallbackRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const appUrl = env.APP_URL;
	if (!appUrl) {
		res.status(500).json({error: 'app_url_not_configured'});
		return;
	}
	// The handshake is single-use: cleared however the return ends.
	res.clearCookie(STATE_COOKIE, cookieOptions());
	const stored = parseCookieHeader(request.headers.cookie ?? '').get(STATE_COOKIE);
	const payload = stored === undefined ? null : readStoredJson(stored, statePayloadSchema).unwrapOr(null);
	if (payload === null) {
		res.redirect(`${appUrl}/`);
		return;
	}
	const finished = await finishInstall(request, appUrl, payload);
	if (finished.isErr()) {
		log.warn('Installing a Slack app failed', {
			kind: finished.error.kind,
			...('message' in finished.error ? {message: finished.error.message} : {}),
			...('cause' in finished.error ? serializeError(finished.error.cause) : {}),
		});
	}
	res.redirect(`${appUrl}${chatPath(payload.slug, payload.personaId)}?slack=${finished.unwrapOr('failed')}`);
}
