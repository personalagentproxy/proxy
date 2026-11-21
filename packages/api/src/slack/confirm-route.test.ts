import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SlackAppForLink, SlackMember, SlackMemberLinking, SlackMemberLinkRow, SlackMessageTaking, SlackTakeUp} from '@proxy/db/slack-messages';

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const AUTH_SECRET = 'auth-secret';
mock.module('../utils/env', () => ({env: {AUTH_SECRET, APP_URL: 'https://proxy.example.com'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const app: SlackAppForLink = {
	id: 'app-1',
	orgId: 'org-1',
	personaId: 'persona-1',
	workspaceId: 'workspace-1',
	slackAppId: 'A01',
	clientId: '111.222',
	secrets: 'enc:{}',
	manifestVersion: 1,
	manifestName: 'Travel',
	botToken: 'enc:xoxb-bot',
	botUserId: 'U0BOT',
	botName: 'travel',
	scopes: [],
	installedAt: new Date(),
	removedAt: null,
	createdAt: new Date(),
	persona: {name: 'Travel'},
	workspace: {teamId: 'T01', name: 'Northwind'},
	org: {name: 'Northwind & Co', slug: 'northwind', experiments: ['slack'], insider: false, owner: {name: 'Dana'}},
};

const getSlackAppForLink = mock(async (): Promise<Result<SlackAppForLink | null, ApiError>> => Ok(app));
const getSlackMember = mock(async (): Promise<Result<SlackMember | null, ApiError>> => Ok(null));
const linkSlackMember = mock(async (_link: {orgId: string; workspaceId: string; slackUserId: string; userId: string}): Promise<Result<SlackMemberLinking, ApiError>> => Ok('linked'));
const listSlackMemberLinks = mock(async (): Promise<Result<SlackMemberLinkRow[], ApiError>> => Ok([]));
const unlinkSlackMember = mock(async (_userId: string, _linkId: string): Promise<Result<boolean, ApiError>> => Ok(true));
const noteSlackMessage = mock(async (): Promise<Result<boolean, ApiError>> => Ok(true));
const takeUpSlackMessage = mock(async (_taking: SlackMessageTaking): Promise<Result<SlackTakeUp, ApiError>> => Ok({kind: 'opened', threadId: 'thread-1', entryId: 'entry-1'}));
mock.module('@proxy/db/slack-messages', () => ({getSlackAppForLink, getSlackMember, linkSlackMember, listSlackMemberLinks, unlinkSlackMember, noteSlackMessage, takeUpSlackMessage}));

const getMembership = mock(async (): Promise<Result<{role: 'owner' | 'member'} | null, ApiError>> => Ok({role: 'member'}));
mock.module('@proxy/db/organization', () => ({getMembership}));

const chat = {id: 'chat-2', orgId: 'org-1', agentId: 'agent-1', personaId: 'persona-1', userId: 'user-2', parentThreadId: null, title: null, taskId: null};
const ensureChat = mock(async (_store: object, _member: {orgId: string; userId: string}, _persona: {id: string}): Promise<Result<typeof chat, ApiError>> => Ok(chat));
mock.module('../harness/member-chat', () => ({ensureChat}));
mock.module('../harness/store', () => ({harnessStore: {}}));

// Slack's Web API: every request it was sent, and what it answers each method.
const prompting = {type: 'message', user: 'U01', text: 'Book the train to Lyon', ts: '1700000000.000100'};
const slack = {
	requests: [] as Array<{method: string; body: URLSearchParams}>,
	replies: (): Response => Response.json({ok: true, messages: [prompting]}),
};
spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const method = url.split('/').at(-1) ?? '';
	slack.requests.push({method, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	return method === 'conversations.replies' ? slack.replies() : Response.json({ok: true, ts: '1700000000.009900'});
}) as typeof fetch);

const {signConfirmToken} = await import('./confirm-link');
const {handleConfirmSlackLinkRoute, handleGetSlackLinkRoute, handleListSlackLinksRoute, handleUnlinkSlackLinkRoute} = await import('./confirm-route');

const claims = {appId: 'app-1', teamId: 'T01', slackUserId: 'U01', channel: 'D01', ts: '1700000000.000100', expiresAt: Math.floor(Date.now() / 1000) + 3600};

function request(params: Record<string, string>, userId = 'user-2') {
	return {params, user: {userId}} as never;
}

const token = (overrides: Partial<typeof claims> = {}) => signConfirmToken({...claims, ...overrides}, AUTH_SECRET);

// The lines said in Slack, once they have gone, after the answer.
async function lines() {
	await Bun.sleep(5);
	return slack.requests.filter(({method}) => method === 'chat.postMessage').map(({body}) => body.get('text'));
}

beforeEach(() => {
	mock.clearAllMocks();
	getSlackAppForLink.mockResolvedValue(Ok(app));
	getSlackMember.mockResolvedValue(Ok(null));
	linkSlackMember.mockResolvedValue(Ok('linked'));
	getMembership.mockResolvedValue(Ok({role: 'member'}));
	takeUpSlackMessage.mockResolvedValue(Ok({kind: 'opened', threadId: 'thread-1', entryId: 'entry-1'}));
	slack.requests = [];
	slack.replies = () => Response.json({ok: true, messages: [prompting]});
});

describe('GET /api/slack-links/:token', () => {
	test('a member is asked to confirm, with the workspace, the organization and the persona', async () => {
		expect((await handleGetSlackLinkRoute(request({token: token()}))).unwrap()).toEqual({
			state: 'confirm',
			workspaceName: 'Northwind',
			orgName: 'Northwind & Co',
			personaName: 'Travel',
			linked: false,
		});

		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));
		expect((await handleGetSlackLinkRoute(request({token: token()}))).unwrap()).toMatchObject({state: 'confirm', linked: true});
	});

	test('someone not in the organization is told so, and whom to ask', async () => {
		getMembership.mockResolvedValue(Ok(null));

		expect((await handleGetSlackLinkRoute(request({token: token()}))).unwrap()).toEqual({state: 'not_member', workspaceName: 'Northwind', orgName: 'Northwind & Co', ownerName: 'Dana'});
	});

	test('a Slack user linked to another member already', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-3', inOrganization: true}));

		expect((await handleGetSlackLinkRoute(request({token: token()}))).unwrap()).toEqual({state: 'taken', workspaceName: 'Northwind', orgName: 'Northwind & Co'});
	});

	test('a link that has run out, and one that isn’t one, or is for another workspace or an organization without the experiment', async () => {
		expect((await handleGetSlackLinkRoute(request({token: token({expiresAt: Math.floor(Date.now() / 1000) - 1})}))).unwrap()).toEqual({state: 'expired'});
		expect((await handleGetSlackLinkRoute(request({token: 'made.up'}))).unwrapErr().kind).toBe('not_found');
		expect((await handleGetSlackLinkRoute(request({token: token({teamId: 'T99'})}))).unwrapErr().kind).toBe('not_found');
		getSlackAppForLink.mockResolvedValue(Ok({...app, org: {...app.org, experiments: []}}));
		expect((await handleGetSlackLinkRoute(request({token: token()}))).unwrapErr().kind).toBe('not_found');
	});
});

describe('POST /api/slack-links/:token', () => {
	test('links the Slack user to the member, reads the prompting message back and takes it up, and says the way back to Slack', async () => {
		const confirmed = (await handleConfirmSlackLinkRoute(request({token: token()}))).unwrap();

		expect(confirmed).toEqual({personaName: 'Travel', takenUp: true, slackUrl: 'https://slack.com/app_redirect?app=A01&team=T01'});
		expect(linkSlackMember).toHaveBeenCalledWith({orgId: 'org-1', workspaceId: 'workspace-1', slackUserId: 'U01', userId: 'user-2'});
		const read = slack.requests.find(({method}) => method === 'conversations.replies');
		expect(Object.fromEntries(read?.body ?? [])).toEqual({channel: 'D01', ts: '1700000000.000100', oldest: '1700000000.000100', latest: '1700000000.000100', inclusive: 'true'});
		expect(ensureChat.mock.calls[0]?.slice(1)).toEqual([{orgId: 'org-1', userId: 'user-2'}, {id: 'persona-1'}]);
		expect(takeUpSlackMessage.mock.calls[0]?.[0]).toMatchObject({appId: 'app-1', channel: 'D01', ts: '1700000000.000100', rootTs: null, chatId: 'chat-2', text: 'Book the train to Lyon'});
		expect(await lines()).toEqual([]);
	});

	test('a prompting message taken up already is not taken twice, and is said to be with the persona', async () => {
		takeUpSlackMessage.mockResolvedValue(Ok({kind: 'taken_already'}));

		expect((await handleConfirmSlackLinkRoute(request({token: token()}))).unwrap().takenUp).toBe(true);
		expect(takeUpSlackMessage).toHaveBeenCalledTimes(1);
		expect(await lines()).toEqual([]);
	});

	test('a prompting message in a Slack thread is taken up there, with its files’ line said after', async () => {
		slack.replies = () => Response.json({ok: true, messages: [{...prompting, ts: '1700000000.000200', thread_ts: '1700000000.000100', subtype: 'file_share', files: [{id: 'F01'}]}]});

		await handleConfirmSlackLinkRoute(request({token: token({ts: '1700000000.000200'})}));

		expect(takeUpSlackMessage.mock.calls[0]?.[0]).toMatchObject({ts: '1700000000.000200', rootTs: '1700000000.000100'});
		expect(await lines()).toEqual(['I can’t read files yet, so I took up your words without them.']);
	});

	test('links all the same where the message is gone from Slack, or is someone else’s', async () => {
		slack.replies = () => Response.json({ok: false, error: 'thread_not_found'});
		expect((await handleConfirmSlackLinkRoute(request({token: token()}))).unwrap().takenUp).toBe(false);

		slack.replies = () => Response.json({ok: true, messages: [{...prompting, user: 'U02'}]});
		expect((await handleConfirmSlackLinkRoute(request({token: token()}))).unwrap().takenUp).toBe(false);
		expect(takeUpSlackMessage).not.toHaveBeenCalled();
		expect(linkSlackMember).toHaveBeenCalledTimes(2);
	});

	test('refuses someone not in the organization, links nothing', async () => {
		getMembership.mockResolvedValue(Ok(null));

		expect((await handleConfirmSlackLinkRoute(request({token: token()}))).unwrapErr().kind).toBe('forbidden');
		expect(linkSlackMember).not.toHaveBeenCalled();
	});

	test('refuses a link that has run out, and a Slack user who is another member’s', async () => {
		expect((await handleConfirmSlackLinkRoute(request({token: token({expiresAt: Math.floor(Date.now() / 1000) - 1})}))).unwrapErr().kind).toBe('validation_error');
		expect(linkSlackMember).not.toHaveBeenCalled();

		linkSlackMember.mockResolvedValue(Ok('other'));
		expect((await handleConfirmSlackLinkRoute(request({token: token()}))).unwrapErr().kind).toBe('conflict');
		expect(takeUpSlackMessage).not.toHaveBeenCalled();
	});
});

describe('the person’s Slack links', () => {
	test('lists them, and unlinks one of theirs', async () => {
		listSlackMemberLinks.mockResolvedValue(Ok([{id: 'link-1', workspaceName: 'Northwind', orgName: 'Northwind & Co', createdAt: new Date('2026-11-01T09:00:00Z')}]));

		expect((await handleListSlackLinksRoute(request({}))).unwrap()).toEqual({links: [{id: 'link-1', workspaceName: 'Northwind', orgName: 'Northwind & Co', createdAt: '2026-11-01T09:00:00.000Z'}]});

		expect((await handleUnlinkSlackLinkRoute(request({linkId: 'link-1'}))).isOk()).toBe(true);
		expect(unlinkSlackMember).toHaveBeenCalledWith('user-2', 'link-1');

		unlinkSlackMember.mockResolvedValue(Ok(false));
		expect((await handleUnlinkSlackLinkRoute(request({linkId: 'link-9'}))).unwrapErr().kind).toBe('not_found');
	});
});
