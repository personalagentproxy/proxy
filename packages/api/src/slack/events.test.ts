import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';

import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {SlackAppRow} from '@proxy/db/slack';
import type {SlackMember, SlackMessageTaking, SlackTakeUp} from '@proxy/db/slack-messages';

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const SECRET = 'signing-secret';

const app: SlackAppRow = {
	id: 'app-1',
	orgId: 'org-1',
	personaId: 'persona-1',
	workspaceId: 'workspace-1',
	slackAppId: 'A01',
	clientId: '111.222',
	secrets: `enc:${JSON.stringify({clientSecret: 'client-secret', signingSecret: SECRET})}`,
	manifestVersion: 1,
	manifestName: 'Finance',
	botToken: 'enc:xoxb-bot',
	botUserId: 'U0BOT',
	botName: 'finance',
	scopes: [],
	installedAt: new Date(),
	removedAt: null,
	createdAt: new Date(Date.now() - 60 * 60 * 1000),
};
const org = {name: 'Northwind & Co', experiments: ['slack'], insider: false};
const workspace = {teamId: 'T01'};
type EventsApp = SlackAppRow & {org: {name: string; experiments: string[]; insider: boolean}; workspace: {teamId: string}};
const getSlackAppForEvents = mock(async (): Promise<Result<EventsApp | null, ApiError>> => Ok({...app, org, workspace}));
const markSlackAppRemoved = mock(async (): Promise<Result<void, ApiError>> => Ok(undefined));
mock.module('@proxy/db/slack', () => ({getSlackAppForEvents, markSlackAppRemoved}));

const AUTH_SECRET = 'auth-secret';
mock.module('../utils/env', () => ({env: {AUTH_SECRET, APP_URL: 'https://proxy.example.com'}}));

// Who is speaking, and what taking a message up comes to, as the database would say.
const getSlackMember = mock(async (): Promise<Result<SlackMember | null, ApiError>> => Ok(null));
const noteSlackMessage = mock(async (): Promise<Result<boolean, ApiError>> => Ok(true));
const takeUpSlackMessage = mock(async (_taking: SlackMessageTaking): Promise<Result<SlackTakeUp, ApiError>> => Ok({kind: 'opened', threadId: 'thread-1', entryId: 'entry-1'}));
mock.module('@proxy/db/slack-messages', () => ({getSlackMember, noteSlackMessage, takeUpSlackMessage}));

// The member's chat with the persona, as the page makes it.
const chat = {id: 'chat-2', orgId: 'org-1', agentId: 'agent-1', personaId: 'persona-1', userId: 'user-2', parentThreadId: null, title: null, taskId: null};
const ensureChat = mock(async (_store: object, _member: {orgId: string; userId: string}, _persona: {id: string}): Promise<Result<typeof chat, ApiError>> => Ok(chat));
mock.module('../harness/member-chat', () => ({ensureChat}));
mock.module('../harness/store', () => ({harnessStore: {}}));

// The thread's place in Slack as its session is set, with nothing set yet; and what was noted of it.
const sessionPlace = {
	id: 'place-1',
	threadId: 'thread-1',
	channel: 'D01',
	rootTs: '1700000000.000100',
	session: {status: null, title: null, setAt: null, attempts: 0, retryAt: null},
	app: {id: 'app-1', botToken: 'enc:xoxb-bot', removedAt: null, sessionsOffUntil: null},
};
const getSlackSessionPlace = mock(async (_threadId: string): Promise<Result<typeof sessionPlace | null, ApiError>> => Ok(sessionPlace));
const readSlackSessionState = mock(async () => Ok({state: {kind: 'working' as const}, waitingForMember: false, alerts: 0, subAgentsAtWork: false, title: 'Book the train to Lyon', lastSeq: 1}));
const noteSlackSessionSet = mock(async (_placeId: string, _status: string, _at: Date, _made: {title: string | null} | null): Promise<Result<void, ApiError>> => Ok(undefined));
const noteSlackSessionRenamed = mock(async (): Promise<Result<void, ApiError>> => Ok(undefined));
const noteSlackSessionFailed = mock(async (): Promise<Result<void, ApiError>> => Ok(undefined));
const turnSlackSessionsOff = mock(async (): Promise<Result<void, ApiError>> => Ok(undefined));
mock.module('@proxy/db/slack-sessions', () => ({getSlackSessionPlace, readSlackSessionState, noteSlackSessionSet, noteSlackSessionRenamed, noteSlackSessionFailed, turnSlackSessionsOff}));

// Slack's Web API: every request it was sent, and what it answers.
const slack = {requests: [] as Array<{url: string; body: URLSearchParams; authorization: string | null}>, answer: (): Response => Response.json({ok: true, ts: '1700000000.009900'})};
spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	slack.requests.push({url, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''), authorization: new Headers(init?.headers).get('authorization')});
	return slack.answer();
}) as typeof fetch);

const {checkSlackSignature, handleSlackEventsRoute} = await import('./events');
const {readConfirmToken} = await import('./confirm-link');

function sign(body: string, timestamp: number, secret = SECRET): string {
	return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

// A request as Express hands it over before any parser: the body still to be read.
function request(body: string, headers: Record<string, string>, id = 'app-1') {
	return Object.assign(Readable.from([Buffer.from(body)]), {headers, params: {id}}) as never;
}

function response() {
	const res = {
		code: 200,
		sent: undefined as unknown,
		status(code: number) {
			res.code = code;
			return res;
		},
		// How many requests Slack had been sent as the answer went: none of the app's lines yet.
		sentBeforeAnswer: -1,
		json(body: unknown) {
			res.sent = body;
		},
		end() {
			res.sentBeforeAnswer = slack.requests.length;
		},
	};
	return res;
}

async function post(body: string, options: {timestamp?: number; signature?: string; id?: string} = {}) {
	const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
	const res = response();
	await handleSlackEventsRoute(request(body, {'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': options.signature ?? sign(body, timestamp)}, options.id), res as never);
	return res;
}

const event = (inner: object) => JSON.stringify({token: 'x', team_id: 'T01', api_app_id: 'A01', type: 'event_callback', event_id: 'Ev01', event_time: 1, event: inner});

beforeEach(() => {
	mock.clearAllMocks();
	getSlackAppForEvents.mockResolvedValue(Ok({...app, org, workspace}));
	getSlackMember.mockResolvedValue(Ok(null));
	noteSlackMessage.mockResolvedValue(Ok(true));
	takeUpSlackMessage.mockResolvedValue(Ok({kind: 'opened', threadId: 'thread-1', entryId: 'entry-1'}));
	getSlackSessionPlace.mockResolvedValue(Ok(sessionPlace));
	slack.requests = [];
	slack.answer = () => Response.json({ok: true, ts: '1700000000.009900'});
});

describe('the signature on Slack’s requests', () => {
	test('is `v0=` and the HMAC SHA-256 of `v0:<timestamp>:<body>` with the app’s signing secret, within five minutes', () => {
		const body = Buffer.from('{"type":"url_verification"}');
		const now = 1_800_000_000_000;
		const at = now / 1000;

		expect(checkSlackSignature(SECRET, {timestamp: String(at), signature: sign(body.toString(), at)}, body, now)).toBe('ok');
		expect(checkSlackSignature(SECRET, {timestamp: String(at), signature: sign(body.toString(), at, 'another')}, body, now)).toBe('bad');
		expect(checkSlackSignature(SECRET, {timestamp: String(at - 301), signature: sign(body.toString(), at - 301)}, body, now)).toBe('stale');
		expect(checkSlackSignature(SECRET, {timestamp: undefined, signature: undefined}, body, now)).toBe('bad');
	});
});

describe('POST /slack/events/:id', () => {
	test('answers Slack’s check of the address with its challenge, signed', async () => {
		const res = await post(JSON.stringify({token: 'x', challenge: 'challenge-1', type: 'url_verification'}));

		expect(res.code).toBe(200);
		expect(res.sent).toEqual({challenge: 'challenge-1'});
	});

	test('refuses a bad signature and a stale timestamp, before anything in the body is believed', async () => {
		const body = event({type: 'app_uninstalled'});

		expect((await post(body, {signature: sign(body, Math.floor(Date.now() / 1000), 'another')})).code).toBe(401);
		const old = Math.floor(Date.now() / 1000) - 600;
		expect((await post(body, {timestamp: old, signature: sign(body, old)})).code).toBe(401);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('answers the check unsigned only while the app is being made and Slack hasn’t told us its secret', async () => {
		const check = JSON.stringify({token: 'x', challenge: 'challenge-2', type: 'url_verification'});
		getSlackAppForEvents.mockResolvedValue(Ok({...app, slackAppId: null, secrets: null, createdAt: new Date(), org, workspace}));

		const res = await post(check, {signature: 'v0=none'});
		expect(res.sent).toEqual({challenge: 'challenge-2'});

		expect((await post(event({type: 'app_uninstalled'}), {signature: 'v0=none'})).code).toBe(401);

		getSlackAppForEvents.mockResolvedValue(Ok({...app, secrets: null, createdAt: new Date(Date.now() - 60 * 60 * 1000), org, workspace}));
		expect((await post(check, {signature: 'v0=none'})).code).toBe(401);
	});

	test('requires the signature once the secret is stored, for the check too', async () => {
		const check = JSON.stringify({token: 'x', challenge: 'challenge-3', type: 'url_verification'});
		getSlackAppForEvents.mockResolvedValue(Ok({...app, createdAt: new Date(), org, workspace}));

		expect((await post(check, {signature: 'v0=none'})).code).toBe(401);
	});

	test('marks the app removed where Slack uninstalled it or revoked its bot’s token', async () => {
		expect((await post(event({type: 'app_uninstalled'}))).code).toBe(200);
		expect(markSlackAppRemoved).toHaveBeenCalledWith('app-1');

		markSlackAppRemoved.mockClear();
		expect((await post(event({type: 'tokens_revoked', tokens: {oauth: [], bot: ['U0BOT']}}))).code).toBe(200);
		expect(markSlackAppRemoved).toHaveBeenCalledWith('app-1');

		markSlackAppRemoved.mockClear();
		expect((await post(event({type: 'tokens_revoked', tokens: {oauth: ['U01']}}))).code).toBe(200);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('acknowledges any other event and leaves it, as one for another app', async () => {
		expect((await post(event({type: 'reaction_added', reaction: 'tada'}))).code).toBe(200);
		const other = JSON.stringify({type: 'event_callback', api_app_id: 'A99', event: {type: 'app_uninstalled'}});
		expect((await post(other)).code).toBe(200);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('finds no app for an id we don’t have, or an organization without the experiment', async () => {
		getSlackAppForEvents.mockResolvedValueOnce(Ok(null));
		expect((await post(event({type: 'app_uninstalled'}), {id: 'nope'})).code).toBe(404);

		getSlackAppForEvents.mockResolvedValueOnce(Ok({...app, org: {name: 'Northwind & Co', experiments: [], insider: false}, workspace}));
		expect((await post(event({type: 'app_uninstalled'}))).code).toBe(404);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('refuses a signed body that isn’t JSON', async () => {
		expect((await post('not json')).code).toBe(400);
	});
});

// A person's message in the app's DM.
const said = (fields: object = {}) => event({type: 'message', channel: 'D01', channel_type: 'im', user: 'U01', text: 'Book the train to Lyon', ts: '1700000000.000100', ...fields});

// The lines the app said in Slack.
const lines = () => slack.requests.filter(({url}) => url.endsWith('/chat.postMessage')).map(({body}) => ({channel: body.get('channel'), thread: body.get('thread_ts'), text: body.get('text')}));

describe('a person’s message in the app’s DM', () => {
	test('from a Slack user linked to nobody: a line with a link to confirm, under the message, once, and nothing opened', async () => {
		const res = await post(said());
		expect(res.code).toBe(200);
		expect(res.sentBeforeAnswer).toBe(0);

		expect(getSlackMember).toHaveBeenCalledWith('workspace-1', 'U01');
		expect(noteSlackMessage).toHaveBeenCalledWith({appId: 'app-1', channel: 'D01', ts: '1700000000.000100'});
		expect(takeUpSlackMessage).not.toHaveBeenCalled();
		const [line] = lines();
		expect(line).toMatchObject({channel: 'D01', thread: '1700000000.000100'});
		expect(slack.requests[0]?.authorization).toBe('Bearer xoxb-bot');
		const token = /\/confirm-slack\/([^|>]+)\|Confirm>$/.exec(line?.text ?? '')?.[1] ?? '';
		expect(readConfirmToken(token, AUTH_SECRET).unwrap()).toMatchObject({appId: 'app-1', teamId: 'T01', slackUserId: 'U01', channel: 'D01', ts: '1700000000.000100'});

		// Slack sends it again: noted already, nothing said.
		slack.requests = [];
		noteSlackMessage.mockResolvedValue(Ok(false));
		await post(said());
		expect(lines()).toEqual([]);
	});

	test('from a member: a thread opened in their chat with the persona, with what they would have typed, and nothing said', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));

		await post(said({text: 'Compare <https://example.com/fares|the fares> &amp; book'}));

		expect(ensureChat.mock.calls[0]?.slice(1)).toEqual([{orgId: 'org-1', userId: 'user-2'}, {id: 'persona-1'}]);
		const [taking] = takeUpSlackMessage.mock.calls[0] ?? [];
		expect(taking).toMatchObject({appId: 'app-1', channel: 'D01', ts: '1700000000.000100', rootTs: null, chatId: 'chat-2', text: 'Compare [the fares](https://example.com/fares) & book'});
		expect(taking?.opening).toMatchObject({title: 'Compare the fares & book', task: {ownerUserId: 'user-2', personaId: 'persona-1'}});
		expect(lines()).toEqual([]);
	});

	test('a reply in a Slack thread goes to the thread it is', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));
		takeUpSlackMessage.mockResolvedValue(Ok({kind: 'continued', threadId: 'thread-1', entryId: 'entry-2'}));

		await post(said({text: 'The 9 o’clock one', ts: '1700000000.000200', thread_ts: '1700000000.000100'}));

		expect(takeUpSlackMessage.mock.calls[0]?.[0]).toMatchObject({ts: '1700000000.000200', rootTs: '1700000000.000100', text: 'The 9 o’clock one'});
		expect(lines()).toEqual([]);
	});

	test('with files: the words taken up, and a line saying the files weren’t; files alone open nothing', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));

		await post(said({subtype: 'file_share', text: 'Here is the invoice', files: [{id: 'F01'}]}));
		expect(takeUpSlackMessage.mock.calls[0]?.[0].text).toBe('Here is the invoice');
		expect(lines()).toEqual([{channel: 'D01', thread: '1700000000.000100', text: 'I can’t read files yet, so I took up your words without them.'}]);

		takeUpSlackMessage.mockClear();
		slack.requests = [];
		await post(said({subtype: 'file_share', text: '', files: [{id: 'F02'}], ts: '1700000000.000300'}));
		expect(takeUpSlackMessage).not.toHaveBeenCalled();
		expect(lines()).toEqual([{channel: 'D01', thread: '1700000000.000300', text: 'I can’t read files yet. Say what you need in words.'}]);
	});

	test('from a member no longer in the organization: a line saying so, and nothing taken up', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: false}));

		await post(said());

		expect(takeUpSlackMessage).not.toHaveBeenCalled();
		expect(lines()).toEqual([{channel: 'D01', thread: '1700000000.000100', text: 'You’re no longer in Northwind &amp; Co in Personal Agent Proxy, so I can’t take this up.'}]);
	});

	test('one taken up already, as Slack sends it again, says nothing more', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));
		takeUpSlackMessage.mockResolvedValue(Ok({kind: 'taken_already'}));

		await post(said({subtype: 'file_share', files: [{id: 'F01'}]}));

		expect(lines()).toEqual([]);
	});

	test('a message taken up sets its thread’s session processing once Slack has its answer, made with its title', async () => {
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));

		const res = await post(said({text: 'Book the train to Lyon'}));

		expect(res.sentBeforeAnswer).toBe(0);
		expect(getSlackSessionPlace).toHaveBeenCalledWith('thread-1');
		const statuses = slack.requests.filter(({url}) => url.endsWith('/agents.sessions.setStatus'));
		expect(statuses.map(({body, authorization}) => [Object.fromEntries(body), authorization])).toEqual([
			[{channel_id: 'D01', thread_ts: '1700000000.000100', status: 'processing', title: 'Book the train to Lyon'}, 'Bearer xoxb-bot'],
		]);
		expect(noteSlackSessionSet.mock.calls[0]?.slice(0, 2)).toEqual(['place-1', 'processing']);
		expect(noteSlackSessionSet.mock.calls[0]?.[3]).toEqual({title: 'Book the train to Lyon'});
	});

	test('a message not taken up sets no session', async () => {
		await post(said());
		getSlackMember.mockResolvedValue(Ok({userId: 'user-2', inOrganization: true}));
		takeUpSlackMessage.mockResolvedValue(Ok({kind: 'taken_already'}));
		await post(said());

		expect(getSlackSessionPlace).not.toHaveBeenCalled();
		expect(slack.requests.some(({url}) => url.endsWith('/agents.sessions.setStatus'))).toBe(false);
	});

	test('the app’s own messages, other bots’, edits and deletions are left', async () => {
		await post(said({user: 'U0BOT', bot_id: 'B0BOT'}));
		await post(said({subtype: 'bot_message', bot_id: 'B02', user: undefined}));
		await post(said({subtype: 'message_changed', hidden: true}));
		await post(said({subtype: 'message_deleted', hidden: true}));

		expect(getSlackMember).not.toHaveBeenCalled();
		expect(slack.requests).toEqual([]);
	});

	test('nothing is taken up for an app removed in Slack', async () => {
		getSlackAppForEvents.mockResolvedValue(Ok({...app, removedAt: new Date(), botToken: null, org, workspace}));

		expect((await post(said())).code).toBe(200);
		expect(getSlackMember).not.toHaveBeenCalled();
	});

	test('a failure is answered 200 all the same: the database’s logged, a line Slack won’t take dropped', async () => {
		getSlackMember.mockResolvedValue(Err(ApiErr.internalError(new Error('down'))));
		expect((await post(said())).code).toBe(200);
		expect(slack.requests).toEqual([]);

		getSlackMember.mockResolvedValue(Ok(null));
		slack.answer = () => Response.json({ok: false, error: 'channel_not_found'});
		expect((await post(said())).code).toBe(200);
		expect(lines()).toHaveLength(1);
	});
});
