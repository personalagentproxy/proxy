import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {PersonaRow} from '@proxy/db/harness';
import type {SlackAppRow, SlackInstall, SlackWorkspaceRow} from '@proxy/db/slack';

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {APP_URL: 'https://proxy.example.com'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['slack']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const now = new Date('2026-11-16T10:00:00Z');
const persona: PersonaRow = {
	id: 'persona-1',
	name: 'Finance',
	look: {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2},
	color: 'blue',
	harness: 'claude-agent-sdk',
	chatModel: 'sonnet',
	ownerUserId: null,
	createdById: 'user-1',
	createdAt: now,
};
mock.module('@proxy/db/harness', () => ({getPersona: mock(async () => Ok(persona))}));
mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'member'}))}));

const workspace: SlackWorkspaceRow = {id: 'workspace-1', orgId: 'org-1', teamId: 'T01', name: 'Northwind', slackUserId: 'U01', credential: 'enc:{}', expiresAt: now, refusedAt: null, createdAt: now};
const waiting: SlackAppRow = {
	id: 'app-1',
	orgId: 'org-1',
	personaId: 'persona-1',
	workspaceId: 'workspace-1',
	slackAppId: 'A01',
	clientId: '111.222',
	secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: 'signing-secret'})}`,
	manifestVersion: 1,
	manifestName: 'Finance',
	botToken: null,
	botUserId: null,
	botName: null,
	scopes: [],
	installedAt: null,
	removedAt: null,
	createdAt: now,
};
const installSlackApp = mock(async (_id: string, _install: SlackInstall): Promise<Result<SlackAppRow, ApiError>> => Ok(waiting));
mock.module('@proxy/db/slack', () => ({
	getPersonaSlackApp: mock(async () => Ok(waiting)),
	getSlackWorkspace: mock(async () => Ok(workspace)),
	installSlackApp,
	// What the routes beside the install use, which it doesn't.
	claimDueSlackWorkspaces: mock(),
	refuseSlackWorkspace: mock(),
	rotateSlackWorkspace: mock(),
	finishSlackApp: mock(),
	forgetSlackApp: mock(),
	linkSlackWorkspace: mock(),
	listSlackWorkspaces: mock(),
	markSlackAppRemoved: mock(),
	startSlackApp: mock(),
	unlinkSlackWorkspace: mock(),
	updateSlackAppManifest: mock(),
}));

// Slack's `oauth.v2.access` and `auth.test`, as each test says.
let access: object = {};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if (url.endsWith('/oauth.v2.access')) {
		return Response.json(access);
	}
	return Response.json({ok: true, team: 'Northwind', user: 'finance', team_id: 'T01', user_id: 'U0BOT'});
}) as typeof fetch);

const {handleSlackInstallCallbackRoute, handleStartSlackInstallRoute} = await import('./install');

// A response that notes where it was sent and the cookies set and cleared.
function response() {
	const res = {
		redirected: '',
		cookies: new Map<string, string>(),
		cleared: [] as string[],
		redirect(to: string) {
			res.redirected = to;
		},
		cookie(name: string, value: string) {
			res.cookies.set(name, value);
		},
		clearCookie(name: string) {
			res.cleared.push(name);
		},
		status() {
			return res;
		},
		json() {},
	};
	return res;
}

function request(args: {params?: Record<string, string>; query?: Record<string, string>; cookie?: string; userId?: string}) {
	return {user: {userId: args.userId ?? 'user-1', email: 'a@example.com'}, params: args.params ?? {}, query: args.query ?? {}, headers: {cookie: args.cookie ?? ''}} as never;
}

// Starts an install, and the state and cookie it kept.
async function start() {
	const res = response();
	await handleStartSlackInstallRoute(request({params: {org: 'acme', personaId: 'persona-1'}}), res as never);
	const url = new URL(res.redirected);
	const cookie = res.cookies.get('proxy.slack-install-state') ?? '';
	return {url, state: url.searchParams.get('state') ?? '', cookie: `proxy.slack-install-state=${encodeURIComponent(cookie)}`};
}

async function finish(query: Record<string, string>, cookie: string, userId = 'user-1') {
	const res = response();
	await handleSlackInstallCallbackRoute(request({query, cookie, userId}), res as never);
	return res;
}

const installed = {
	ok: true,
	access_token: 'xoxb-bot',
	token_type: 'bot',
	scope: 'im:history,chat:write,assistant:write',
	bot_user_id: 'U0BOT',
	app_id: 'A01',
	team: {id: 'T01', name: 'Northwind'},
	is_enterprise_install: false,
};

beforeEach(() => {
	mock.clearAllMocks();
	access = installed;
});

afterEach(() => {
	fetchSpy.mockClear();
});

describe('installing a persona’s Slack app', () => {
	test('sends the browser to Slack’s install for the app, in its workspace, with a state kept in a cookie', async () => {
		const {url, state} = await start();

		expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
		expect(url.searchParams.get('client_id')).toBe('111.222');
		expect(url.searchParams.get('scope')).toBe('im:history,chat:write,assistant:write,im:write');
		expect(url.searchParams.get('redirect_uri')).toBe('https://proxy.example.com/slack/install');
		expect(url.searchParams.get('team')).toBe('T01');
		expect(state).toMatch(/^[0-9a-f]{32}$/);
	});

	test('on return, trades the code for the bot’s token and keeps it encrypted with the bot, its handle and the scopes', async () => {
		const {state, cookie} = await start();

		const res = await finish({state, code: 'code-1'}, cookie);

		expect(res.redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=installed');
		expect(res.cleared).toEqual(['proxy.slack-install-state']);
		expect(installSlackApp).toHaveBeenCalledWith('app-1', {
			botToken: 'enc:xoxb-bot',
			botUserId: 'U0BOT',
			botName: 'finance',
			scopes: ['im:history', 'chat:write', 'assistant:write'],
			workspaceName: 'Northwind',
		});
	});

	test('refuses a state that doesn’t match, or another person’s return, installing nothing', async () => {
		const {state, cookie} = await start();

		expect((await finish({state: 'forged', code: 'code-1'}, cookie)).redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=failed');
		expect((await finish({state, code: 'code-1'}, cookie, 'user-2')).redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=failed');
		expect((await finish({state, code: 'code-1'}, '')).redirected).toBe('https://proxy.example.com/');
		expect(installSlackApp).not.toHaveBeenCalled();
	});

	test('refuses an install across a whole Enterprise organization, and one in another workspace', async () => {
		const {state, cookie} = await start();

		access = {...installed, team: null, enterprise: {id: 'E01', name: 'Northwind Group'}, is_enterprise_install: true};
		expect((await finish({state, code: 'code-1'}, cookie)).redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=enterprise');

		access = {...installed, team: {id: 'T02', name: 'Elsewhere'}};
		expect((await finish({state, code: 'code-1'}, cookie)).redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=workspace');
		expect(installSlackApp).not.toHaveBeenCalled();
	});

	test('says the member turned it down there', async () => {
		const {state, cookie} = await start();

		expect((await finish({state, error: 'access_denied'}, cookie)).redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=denied');
	});

	test('goes back to the persona saying it failed where the app isn’t made yet, or the experiment is off', async () => {
		requireViewer.mockResolvedValueOnce(Ok({...viewer, experiments: []}));
		const res = response();
		await handleStartSlackInstallRoute(request({params: {org: 'acme', personaId: 'persona-1'}}), res as never);
		expect(res.redirected).toBe('https://proxy.example.com/acme/chat/persona-1?slack=failed');
		expect(res.cookies.size).toBe(0);
	});
});
