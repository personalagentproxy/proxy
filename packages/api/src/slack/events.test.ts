import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SlackAppRow} from '@proxy/db/slack';

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
const org = {experiments: ['slack'], insider: false};
const getSlackAppForEvents = mock(async (): Promise<Result<(SlackAppRow & {org: {experiments: string[]; insider: boolean}}) | null, ApiError>> => Ok({...app, org}));
const markSlackAppRemoved = mock(async (): Promise<Result<void, ApiError>> => Ok(undefined));
mock.module('@proxy/db/slack', () => ({getSlackAppForEvents, markSlackAppRemoved}));

const {checkSlackSignature, handleSlackEventsRoute} = await import('./events');

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
		json(body: unknown) {
			res.sent = body;
		},
		end() {},
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
	getSlackAppForEvents.mockResolvedValue(Ok({...app, org}));
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
		getSlackAppForEvents.mockResolvedValue(Ok({...app, slackAppId: null, secrets: null, createdAt: new Date(), org}));

		const res = await post(check, {signature: 'v0=none'});
		expect(res.sent).toEqual({challenge: 'challenge-2'});

		expect((await post(event({type: 'app_uninstalled'}), {signature: 'v0=none'})).code).toBe(401);

		getSlackAppForEvents.mockResolvedValue(Ok({...app, secrets: null, createdAt: new Date(Date.now() - 60 * 60 * 1000), org}));
		expect((await post(check, {signature: 'v0=none'})).code).toBe(401);
	});

	test('requires the signature once the secret is stored, for the check too', async () => {
		const check = JSON.stringify({token: 'x', challenge: 'challenge-3', type: 'url_verification'});
		getSlackAppForEvents.mockResolvedValue(Ok({...app, createdAt: new Date(), org}));

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
		expect((await post(event({type: 'message', channel_type: 'im', text: 'Book the train'}))).code).toBe(200);
		const other = JSON.stringify({type: 'event_callback', api_app_id: 'A99', event: {type: 'app_uninstalled'}});
		expect((await post(other)).code).toBe(200);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('finds no app for an id we don’t have, or an organization without the experiment', async () => {
		getSlackAppForEvents.mockResolvedValueOnce(Ok(null));
		expect((await post(event({type: 'app_uninstalled'}), {id: 'nope'})).code).toBe(404);

		getSlackAppForEvents.mockResolvedValueOnce(Ok({...app, org: {experiments: [], insider: false}}));
		expect((await post(event({type: 'app_uninstalled'}))).code).toBe(404);
		expect(markSlackAppRemoved).not.toHaveBeenCalled();
	});

	test('refuses a signed body that isn’t JSON', async () => {
		expect((await post('not json')).code).toBe(400);
	});
});
