import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {PersonaRow} from '@proxy/db/harness';
import type {SlackAppRow, SlackAppStart, SlackWorkspaceRow, Unlink} from '@proxy/db/slack';

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const env: {APP_URL: string} = {APP_URL: 'https://proxy.example.com'};
mock.module('../utils/env', () => ({env}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['slack']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const now = new Date('2026-11-16T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona: PersonaRow = {id: 'persona-1', name: 'Finance', look, color: 'blue', harness: 'claude-agent-sdk', chatModel: 'sonnet', ownerUserId: null, createdById: 'user-1', createdAt: now};
const getPersona = mock(async (): Promise<Result<PersonaRow | null, ApiError>> => Ok(persona));
mock.module('@proxy/db/harness', () => ({getPersona}));

const workspaceRow: SlackWorkspaceRow = {
	id: 'workspace-1',
	orgId: 'org-1',
	teamId: 'T01',
	name: 'Northwind',
	slackUserId: 'U01',
	credential: `enc:${JSON.stringify({token: 'xoxe.xoxp-1', refreshToken: 'xoxe-1-1'})}`,
	expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000),
	refusedAt: null,
	createdAt: now,
};
const appRow: SlackAppRow = {
	id: 'app-1',
	orgId: 'org-1',
	personaId: 'persona-1',
	workspaceId: 'workspace-1',
	slackAppId: 'A01',
	clientId: '111.222',
	secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: 'signing-secret'})}`,
	manifestVersion: 1,
	manifestName: 'Finance',
	botToken: 'enc:xoxb-bot',
	botUserId: 'U0BOT',
	botName: 'finance',
	scopes: ['im:history', 'chat:write', 'assistant:write', 'im:write'],
	installedAt: now,
	removedAt: null,
	createdAt: now,
};

const db = {
	listSlackWorkspaces: mock(async (): Promise<Result<Array<SlackWorkspaceRow & {apps: number}>, ApiError>> => Ok([{...workspaceRow, apps: 0}])),
	getSlackWorkspace: mock(async (): Promise<Result<SlackWorkspaceRow | null, ApiError>> => Ok(workspaceRow)),
	linkSlackWorkspace: mock(async (): Promise<Result<SlackWorkspaceRow, ApiError>> => Ok(workspaceRow)),
	unlinkSlackWorkspace: mock(async (): Promise<Result<Unlink, ApiError>> => Ok('unlinked')),
	getPersonaSlackApp: mock(async (): Promise<Result<SlackAppRow | null, ApiError>> => Ok(null)),
	startSlackApp: mock(async (): Promise<Result<SlackAppStart, ApiError>> =>
		Ok({kind: 'started', app: {...appRow, slackAppId: null, clientId: null, secrets: null, botToken: null, botUserId: null, botName: null, scopes: [], installedAt: null}}),
	),
	finishSlackApp: mock(async (_id: string, made: {slackAppId: string; clientId: string; secrets: string}): Promise<Result<SlackAppRow, ApiError>> =>
		Ok({...appRow, ...made, botToken: null, botUserId: null, botName: null, scopes: [], installedAt: null}),
	),
	forgetSlackApp: mock(async (): Promise<Result<boolean, ApiError>> => Ok(true)),
	updateSlackAppManifest: mock(async (_id: string, manifest: {manifestVersion: number; manifestName: string}): Promise<Result<SlackAppRow, ApiError>> => Ok({...appRow, ...manifest})),
	markSlackAppRemoved: mock(async (): Promise<Result<void, ApiError>> => Ok(undefined)),
	refuseSlackWorkspace: mock(async (): Promise<Result<void, ApiError>> => Ok(undefined)),
	rotateSlackWorkspace: mock(),
	claimDueSlackWorkspaces: mock(),
};
mock.module('@proxy/db/slack', () => db);

// Slack's Web API: what each method answers, and what it was sent.
type Seen = {method: string; body: URLSearchParams; authorization: string | null};
let answers: Record<string, () => Response> = {};
let seen: Seen[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const method = url.replace('https://slack.com/api/', '');
	seen.push({method, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''), authorization: new Headers(init?.headers).get('authorization')});
	return (answers[method] ?? (() => Response.json({ok: false, error: 'unknown_method'})))();
}) as typeof fetch);

const routes = await import('./route');

function request(params: Record<string, string> = {}, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'a@example.com'}, params, body} as never;
}

const created = () =>
	Response.json({
		ok: true,
		app_id: 'A01',
		credentials: {client_id: '111.222', client_secret: 'client-secret', verification_token: 'v', signing_secret: 'signing-secret'},
		oauth_authorize_url: 'https://slack.com/oauth/v2/authorize',
	});

beforeEach(() => {
	mock.clearAllMocks();
	env.APP_URL = 'https://proxy.example.com';
	requireViewer.mockResolvedValue(Ok(viewer));
	getPersona.mockResolvedValue(Ok(persona));
	db.getPersonaSlackApp.mockResolvedValue(Ok(null));
	db.getSlackWorkspace.mockResolvedValue(Ok(workspaceRow));
	answers = {};
	seen = [];
});

afterEach(() => {
	fetchSpy.mockClear();
});

describe('linking a Slack workspace', () => {
	test('rotates the pasted refresh token at once and keeps the new pair, encrypted, with the workspace’s name', async () => {
		answers['tooling.tokens.rotate'] = () => Response.json({ok: true, token: 'xoxe.xoxp-2', refresh_token: 'xoxe-1-2', team_id: 'T01', user_id: 'U01', iat: 1, exp: 1_900_000_000});
		answers['auth.test'] = () => Response.json({ok: true, url: 'https://northwind.slack.com/', team: 'Northwind', user: 'dana', team_id: 'T01', user_id: 'U01'});

		const linked = await routes.handleLinkSlackWorkspaceRoute(request({}, {token: 'xoxe.xoxp-1', refreshToken: ' xoxe-1-1 '}));

		expect(linked.unwrap()).toEqual({workspace: {id: 'workspace-1', name: 'Northwind', needsToken: false, inUse: false}});
		expect(seen[0]?.body.get('refresh_token')).toBe('xoxe-1-1');
		expect(seen[1]?.authorization).toBe('Bearer xoxe.xoxp-2');
		expect(db.linkSlackWorkspace).toHaveBeenCalledWith({
			orgId: 'org-1',
			teamId: 'T01',
			name: 'Northwind',
			slackUserId: 'U01',
			linkedById: 'user-1',
			credential: `enc:${JSON.stringify({token: 'xoxe.xoxp-2', refreshToken: 'xoxe-1-2'})}`,
			expiresAt: new Date(1_900_000_000_000),
			rotateAt: new Date(1_900_000_000_000 - 2 * 60 * 60 * 1000),
		});
	});

	test('says plainly where Slack doesn’t take the refresh token, linking nothing', async () => {
		answers['tooling.tokens.rotate'] = () => Response.json({ok: false, error: 'invalid_refresh_token'});

		expect((await routes.handleLinkSlackWorkspaceRoute(request({}, {token: 'a', refreshToken: 'b'}))).unwrapErr()).toEqual(
			ApiErr.validationError('Slack didn’t take that refresh token. Generate a new pair and paste both.'),
		);
		expect(db.linkSlackWorkspace).not.toHaveBeenCalled();
	});

	test('unlinks a workspace, and refuses while a persona’s app is in it', async () => {
		expect((await routes.handleUnlinkSlackWorkspaceRoute(request({workspaceId: 'workspace-1'}))).isOk()).toBe(true);
		db.unlinkSlackWorkspace.mockResolvedValueOnce(Ok('in_use'));
		expect((await routes.handleUnlinkSlackWorkspaceRoute(request({workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(ApiErr.conflict('An agent is in this workspace. Remove it from Slack first.'));
	});
});

describe('adding a persona to Slack', () => {
	test('makes the row, then the app from the manifest, keeps its id, client and secrets encrypted, and sends the member to install it', async () => {
		answers['apps.manifest.create'] = created;

		const added = (await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrap();

		expect(db.startSlackApp).toHaveBeenCalledWith({orgId: 'org-1', personaId: 'persona-1', workspaceId: 'workspace-1', manifestVersion: 1, manifestName: 'Finance', addedById: 'user-1'});
		const manifest = JSON.parse(seen[0]?.body.get('manifest') ?? '{}');
		expect(manifest.settings.event_subscriptions.request_url).toBe('https://proxy.example.com/slack/events/app-1');
		expect(seen[0]?.authorization).toBe('Bearer xoxe.xoxp-1');
		expect(db.finishSlackApp).toHaveBeenCalledWith('app-1', {
			slackAppId: 'A01',
			clientId: '111.222',
			secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: 'signing-secret'})}`,
		});
		expect(added).toEqual({app: {state: 'waiting', workspaceId: 'workspace-1', workspaceName: 'Northwind', handle: null, settingsUrl: 'https://api.slack.com/apps/A01/general'}, install: true});
	});

	test('forgets the row where Slack refuses, saying why in words the member can act on', async () => {
		const cases: Array<[() => Response, string]> = [
			[
				() => Response.json({ok: false, error: 'invalid_manifest', errors: [{message: 'An app with this name already exists.', pointer: '/display_information/name'}]}),
				'Slack won’t take the name Finance: An app with this name already exists. Rename the agent and try again.',
			],
			[() => Response.json({ok: false, error: 'managed_app_limit_reached'}), 'Northwind’s Slack plan has no room for another app. Remove one there, or upgrade the plan, and try again.'],
			[() => Response.json({ok: false, error: 'app_approval_required'}), 'A Slack admin of Northwind has to approve the app first. Ask one, then try again.'],
			[() => Response.json({ok: false, error: 'missing_scope'}), 'The token Northwind was linked with can’t make apps there. Link it again with a token from someone allowed to install apps in it.'],
			[() => new Response('', {status: 429}), 'Slack is limiting how often it is asked right now. Wait a minute and try again.'],
		];
		for (const [answer, message] of cases) {
			db.forgetSlackApp.mockClear();
			answers['apps.manifest.create'] = answer;
			const refused = (await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr();
			expect('message' in refused ? refused.message : '').toBe(message);
			expect(db.forgetSlackApp).toHaveBeenCalledWith('app-1');
		}
		expect(db.finishSlackApp).not.toHaveBeenCalled();
	});

	test('marks the workspace as needing a token where Slack no longer takes it', async () => {
		answers['apps.manifest.create'] = () => Response.json({ok: false, error: 'token_revoked'});

		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toMatchObject({kind: 'conflict'});
		expect(db.refuseSlackWorkspace).toHaveBeenCalledWith('workspace-1');
	});

	test('adds only a shared persona, one app each, for whoever may change it, and only where APP_URL is https', async () => {
		getPersona.mockResolvedValueOnce(Ok({...persona, ownerUserId: 'user-1'}));
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(
			ApiErr.conflict('Share Finance with everyone in Acme first: only a shared agent can be added to Slack.'),
		);

		db.startSlackApp.mockResolvedValueOnce(Ok({kind: 'exists'}));
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(ApiErr.conflict('Finance is in Slack already.'));

		db.startSlackApp.mockResolvedValueOnce(Ok({kind: 'not_shared'}));
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toMatchObject({kind: 'conflict'});

		getPersona.mockResolvedValueOnce(Ok({...persona, createdById: 'user-2'}));
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(ApiErr.forbidden());

		env.APP_URL = 'http://localhost:5173';
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(
			ApiErr.conflict('Slack only sends to https addresses, and this Personal Agent Proxy is at http://localhost:5173 (APP_URL). Set APP_URL to its https address to add agents to Slack.'),
		);
		expect(seen).toEqual([]);
	});

	test('refuses everything without the slack experiment', async () => {
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));

		expect((await routes.handlePersonaSlackRoute(request({personaId: 'persona-1'}))).unwrapErr()).toEqual(ApiErr.forbidden());
		expect((await routes.handleAddToSlackRoute(request({personaId: 'persona-1'}, {workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(ApiErr.forbidden());
		expect((await routes.handleLinkSlackWorkspaceRoute(request({}, {token: 'a', refreshToken: 'b'}))).unwrapErr()).toEqual(ApiErr.forbidden());
		expect((await routes.handleUnlinkSlackWorkspaceRoute(request({workspaceId: 'workspace-1'}))).unwrapErr()).toEqual(ApiErr.forbidden());
		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).unwrapErr()).toEqual(ApiErr.forbidden());
		expect(seen).toEqual([]);
	});
});

describe('where a persona’s app stands', () => {
	async function stateOf(app: SlackAppRow, name = 'Finance') {
		getPersona.mockResolvedValueOnce(Ok({...persona, name}));
		db.getPersonaSlackApp.mockResolvedValueOnce(Ok(app));
		return (await routes.handlePersonaSlackRoute(request({personaId: 'persona-1'}))).unwrap().app?.state;
	}

	test('is waiting until installed, in Slack once it is, out of date for an older manifest, a rename or a scope not granted, and removed once Slack said so', async () => {
		expect(await stateOf({...appRow, botToken: null, installedAt: null})).toBe('waiting');
		expect(await stateOf(appRow)).toBe('in_slack');
		expect(await stateOf({...appRow, manifestVersion: 0})).toBe('out_of_date');
		expect(await stateOf(appRow, 'Money')).toBe('out_of_date');
		expect(await stateOf({...appRow, scopes: ['chat:write']})).toBe('out_of_date');
		expect(await stateOf({...appRow, removedAt: now, botToken: null})).toBe('removed');
	});

	test('lists the workspaces, which needs its token again and which has an app in it, and why none can be added here', async () => {
		db.listSlackWorkspaces.mockResolvedValueOnce(Ok([{...workspaceRow, apps: 1, refusedAt: now}]));
		env.APP_URL = 'http://localhost:5173';

		const answer = (await routes.handlePersonaSlackRoute(request({personaId: 'persona-1'}))).unwrap();

		expect(answer.workspaces).toEqual([{id: 'workspace-1', name: 'Northwind', needsToken: true, inUse: true}]);
		expect(answer.app).toBeNull();
		expect(answer.unavailable).toContain('https');
	});
});

describe('where a member writes to a persona in Slack', () => {
	async function presenceOf(app: SlackAppRow | null) {
		db.getPersonaSlackApp.mockResolvedValueOnce(Ok(app));
		return (await routes.handlePersonaInSlackRoute(request({personaId: 'persona-1'}))).unwrap().inSlack;
	}

	test('is its handle, its workspace and its messages there, for a member who may not change it, once it is installed', async () => {
		getPersona.mockResolvedValue(Ok({...persona, createdById: 'user-2'}));

		expect(await presenceOf(appRow)).toEqual({handle: 'finance', workspaceName: 'Northwind', slackUrl: 'https://slack.com/app_redirect?app=A01&team=T01'});
		expect(await presenceOf({...appRow, manifestVersion: 0})).toMatchObject({handle: 'finance'});
	});

	test('is nothing where it has no app, or one waiting to be installed or removed in Slack', async () => {
		expect(await presenceOf(null)).toBeNull();
		expect(await presenceOf({...appRow, botToken: null, botName: null, installedAt: null})).toBeNull();
		expect(await presenceOf({...appRow, removedAt: now, botToken: null})).toBeNull();
	});

	test('is not found for a persona the member doesn’t see, and refused without the experiment', async () => {
		getPersona.mockResolvedValueOnce(Ok(null));
		expect((await routes.handlePersonaInSlackRoute(request({personaId: 'persona-1'}))).unwrapErr().kind).toBe('not_found');

		requireViewer.mockResolvedValueOnce(Ok({...viewer, experiments: []}));
		expect((await routes.handlePersonaInSlackRoute(request({personaId: 'persona-1'}))).unwrapErr().kind).toBe('forbidden');
	});
});

describe('updating a persona’s app', () => {
	test('replaces its manifest in place with ours and the persona’s name as it is now', async () => {
		db.getPersonaSlackApp.mockResolvedValue(Ok({...appRow, manifestVersion: 0}));
		getPersona.mockResolvedValue(Ok({...persona, name: 'Money'}));
		answers['apps.manifest.update'] = () => Response.json({ok: true, app_id: 'A01', permissions_updated: false});
		answers['auth.test'] = () => Response.json({ok: true, team: 'Northwind', user: 'money', team_id: 'T01', user_id: 'U0BOT'});

		const updated = (await routes.handleUpdateSlackAppRoute(request({personaId: 'persona-1'}))).unwrap();

		expect(seen[0]?.body.get('app_id')).toBe('A01');
		expect(JSON.parse(seen[0]?.body.get('manifest') ?? '{}').display_information.name).toBe('Money');
		expect(db.updateSlackAppManifest).toHaveBeenCalledWith('app-1', {manifestVersion: 1, manifestName: 'Money'});
		expect(updated).toMatchObject({app: {state: 'in_slack'}, install: false});
	});

	test('sends the member through the install again where the app now asks for more than was granted', async () => {
		db.getPersonaSlackApp.mockResolvedValue(Ok({...appRow, manifestVersion: 0, scopes: ['chat:write']}));
		db.updateSlackAppManifest.mockResolvedValueOnce(Ok({...appRow, scopes: ['chat:write']}));
		answers['apps.manifest.update'] = () => Response.json({ok: true, app_id: 'A01', permissions_updated: true});
		answers['auth.test'] = () => Response.json({ok: true, team: 'Northwind', user: 'finance', team_id: 'T01', user_id: 'U0BOT'});

		expect((await routes.handleUpdateSlackAppRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({app: {state: 'out_of_date'}, install: true});
	});

	test('marks the app removed where its bot’s token stopped working', async () => {
		db.getPersonaSlackApp.mockResolvedValue(Ok(appRow));
		answers['apps.manifest.update'] = () => Response.json({ok: true, app_id: 'A01'});
		answers['auth.test'] = () => Response.json({ok: false, error: 'token_revoked'});

		expect((await routes.handleUpdateSlackAppRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({app: {state: 'removed'}, install: false});
		expect(db.markSlackAppRemoved).toHaveBeenCalledWith('app-1');
	});
});

describe('removing a persona’s app', () => {
	test('deletes it in Slack, then forgets it here; one Slack has no more counts as deleted', async () => {
		db.getPersonaSlackApp.mockResolvedValue(Ok(appRow));
		answers['apps.manifest.delete'] = () => Response.json({ok: true});

		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).isOk()).toBe(true);
		expect(seen.map(({method, body}) => [method, body.get('app_id')])).toEqual([['apps.manifest.delete', 'A01']]);
		expect(db.forgetSlackApp).toHaveBeenCalledWith('app-1');

		answers['apps.manifest.delete'] = () => Response.json({ok: false, error: 'app_not_found'});
		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).isOk()).toBe(true);
	});

	test('forgets nothing where Slack can’t be reached or the token is gone, and forgets it here alone when asked', async () => {
		db.getPersonaSlackApp.mockResolvedValue(Ok(appRow));
		answers['apps.manifest.delete'] = () => new Response('', {status: 503});
		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).unwrapErr()).toMatchObject({kind: 'provider_unreachable'});

		db.getSlackWorkspace.mockResolvedValue(Ok({...workspaceRow, refusedAt: now}));
		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).unwrapErr()).toMatchObject({kind: 'conflict'});
		expect(db.forgetSlackApp).not.toHaveBeenCalled();

		expect((await routes.handleForgetSlackAppRoute(request({personaId: 'persona-1'}))).isOk()).toBe(true);
		expect(db.forgetSlackApp).toHaveBeenCalledWith('app-1');
	});

	test('says where the persona has no app', async () => {
		expect((await routes.handleRemoveSlackAppRoute(request({personaId: 'persona-1'}))).unwrapErr()).toMatchObject({kind: 'not_found'});
		expect((await routes.handleForgetSlackAppRoute(request({personaId: 'persona-1'}))).unwrapErr()).toMatchObject({kind: 'not_found'});
	});
});
