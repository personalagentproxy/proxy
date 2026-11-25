import {afterEach, describe, expect, spyOn, test} from 'bun:test';

import {createApp, deleteApp, exchangeInstallCode, rotateConfigurationToken, testToken, updateApp} from './slack-api';

type Seen = {url: string; headers: Headers; body: URLSearchParams};

// Slack's Web API as these tests have it: what it answers next, and every request it was sent.
const slack = {requests: [] as Seen[], answer: (): Response | Promise<Response> => Response.json({ok: true})};

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	slack.requests.push({url, headers: new Headers(init?.headers), body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '')});
	return slack.answer();
}) as typeof fetch);

afterEach(() => {
	fetchSpy.mockClear();
	slack.requests = [];
});

describe('the Slack Web API client', () => {
	test('rotates a configuration token with its refresh token alone, and reads whose it is and when it runs out', async () => {
		slack.answer = () => Response.json({ok: true, token: 'xoxe.xoxp-new', refresh_token: 'xoxe-1-next', team_id: 'T01', user_id: 'U01', iat: 1_800_000_000, exp: 1_800_043_200});

		const rotated = (await rotateConfigurationToken('xoxe-1-old')).unwrap();

		expect(rotated).toEqual({token: 'xoxe.xoxp-new', refreshToken: 'xoxe-1-next', teamId: 'T01', userId: 'U01', expiresAt: new Date(1_800_043_200_000)});
		const [sent] = slack.requests;
		expect(sent?.url).toBe('https://slack.com/api/tooling.tokens.rotate');
		expect(sent?.body.get('refresh_token')).toBe('xoxe-1-old');
		expect(sent?.headers.get('authorization')).toBeNull();
		expect(sent?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
	});

	test('sends a manifest as a JSON string with the configuration token as a bearer, and reads the app Slack made', async () => {
		slack.answer = () =>
			Response.json({
				ok: true,
				app_id: 'A01',
				credentials: {client_id: '111.222', client_secret: 'client-secret', verification_token: 'old-token', signing_secret: 'signing-secret'},
				oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=111.222',
			});

		const created = (await createApp('xoxe.xoxp-1', {display_information: {name: 'Finance'}})).unwrap();

		expect(created).toEqual({appId: 'A01', clientId: '111.222', clientSecret: 'client-secret', signingSecret: 'signing-secret'});
		const [sent] = slack.requests;
		expect(sent?.url).toBe('https://slack.com/api/apps.manifest.create');
		expect(sent?.headers.get('authorization')).toBe('Bearer xoxe.xoxp-1');
		expect(JSON.parse(sent?.body.get('manifest') ?? '')).toEqual({display_information: {name: 'Finance'}});
	});

	test('names the app to update and delete', async () => {
		slack.answer = () => Response.json({ok: true, app_id: 'A01', permissions_updated: false});
		expect((await updateApp('xoxe.xoxp-1', 'A01', {})).isOk()).toBe(true);
		slack.answer = () => Response.json({ok: true});
		expect((await deleteApp('xoxe.xoxp-1', 'A01')).isOk()).toBe(true);

		expect(slack.requests.map(({url, body}) => [url, body.get('app_id')])).toEqual([
			['https://slack.com/api/apps.manifest.update', 'A01'],
			['https://slack.com/api/apps.manifest.delete', 'A01'],
		]);
	});

	test('turns `ok: false` into Slack’s code, with what is wrong where in a manifest it won’t take', async () => {
		slack.answer = () => Response.json({ok: false, error: 'invalid_manifest', errors: [{message: 'Name is already taken.', pointer: '/display_information/name'}]});

		expect((await createApp('xoxe.xoxp-1', {})).unwrapErr()).toEqual({
			kind: 'refused',
			method: 'apps.manifest.create',
			error: 'invalid_manifest',
			problems: [{message: 'Name is already taken.', pointer: '/display_information/name'}],
		});

		slack.answer = () => Response.json({ok: false, error: 'invalid_refresh_token'});
		expect((await rotateConfigurationToken('xoxe-1-spent')).unwrapErr()).toEqual({kind: 'refused', method: 'tooling.tokens.rotate', error: 'invalid_refresh_token', problems: []});
	});

	test('reads a rate limit, with how long Slack says to wait', async () => {
		slack.answer = () => new Response('', {status: 429, headers: {'retry-after': '30'}});
		expect((await testToken('xoxb-1')).unwrapErr()).toEqual({kind: 'rate_limited', method: 'auth.test', retryAfterSeconds: 30});

		slack.answer = () => Response.json({ok: false, error: 'ratelimited'});
		expect((await testToken('xoxb-1')).unwrapErr()).toEqual({kind: 'rate_limited', method: 'auth.test', retryAfterSeconds: null});
	});

	test('reads a network failure, a server error and an answer that isn’t Slack’s as Slack unreachable', async () => {
		slack.answer = () => Promise.reject(new TypeError('fetch failed'));
		expect((await testToken('xoxb-1')).unwrapErr()).toMatchObject({kind: 'unreachable', method: 'auth.test', cause: {kind: 'network'}});

		slack.answer = () => new Response('Bad gateway', {status: 502});
		expect((await testToken('xoxb-1')).unwrapErr()).toMatchObject({kind: 'unreachable', cause: {kind: 'http', status: 502}});

		slack.answer = () => Response.json({ok: true});
		expect((await testToken('xoxb-1')).unwrapErr()).toMatchObject({kind: 'unreachable', cause: {kind: 'schema'}});
	});

	test('trades an install’s code with the app’s client as Basic, and reads the bot, its scopes and where it was installed', async () => {
		slack.answer = () =>
			Response.json({
				ok: true,
				access_token: 'xoxb-bot',
				token_type: 'bot',
				scope: 'im:history,chat:write,assistant:write',
				bot_user_id: 'U0BOT',
				app_id: 'A01',
				team: {name: 'Northwind', id: 'T01'},
				enterprise: null,
				is_enterprise_install: false,
			});

		const installed = (await exchangeInstallCode({clientId: '111.222', clientSecret: 'client-secret'}, {code: 'code-1', redirectUri: 'https://proxy.example.com/slack/install'})).unwrap();

		expect(installed).toEqual({
			botToken: 'xoxb-bot',
			botUserId: 'U0BOT',
			appId: 'A01',
			scopes: ['im:history', 'chat:write', 'assistant:write'],
			team: {id: 'T01', name: 'Northwind'},
			enterprise: false,
		});
		const [sent] = slack.requests;
		expect(sent?.url).toBe('https://slack.com/api/oauth.v2.access');
		expect(sent?.headers.get('authorization')).toBe(`Basic ${Buffer.from('111.222:client-secret').toString('base64')}`);
		expect(sent?.body.get('code')).toBe('code-1');
		expect(sent?.body.get('redirect_uri')).toBe('https://proxy.example.com/slack/install');
		expect(sent?.body.get('client_secret')).toBeNull();
	});

	test('reads an install across a whole Enterprise organization, which has no workspace', async () => {
		slack.answer = () =>
			Response.json({
				ok: true,
				access_token: 'xoxb-bot',
				scope: 'chat:write',
				bot_user_id: 'U0BOT',
				app_id: 'A01',
				team: null,
				enterprise: {id: 'E01', name: 'Northwind Group'},
				is_enterprise_install: true,
			});

		expect((await exchangeInstallCode({clientId: '1', clientSecret: '2'}, {code: 'c', redirectUri: 'https://x.test/slack/install'})).unwrap()).toMatchObject({team: null, enterprise: true});
	});
});
