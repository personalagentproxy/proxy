import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test';

import {createNotifier, formatSlackPayload, type SlackPayload} from './slack';

function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(impl, {preconnect: fetch.preconnect}),
	);
}

const config = {
	botToken: 'xoxb-test',
	channels: {alerts: 'C1', signups: 'C2'},
	env: 'production' as const,
};

afterEach(() => {
	mock.restore();
});

describe('formatSlackPayload', () => {
	it('builds a header, the body and the context as fields, with a plain fallback', () => {
		const payload = formatSlackPayload(
			{channel: 'alerts', title: 'Errors', body: 'Two', severity: 'error', ctx: {a: 1, b: {c: 2}}},
			'C1',
		);
		expect(payload.channel).toBe('C1');
		expect(payload.text).toBe(':rotating_light: Errors');
		expect(payload.blocks).toEqual([
			{type: 'header', text: {type: 'plain_text', text: 'Errors', emoji: true}},
			{type: 'section', text: {type: 'mrkdwn', text: 'Two'}},
			{
				type: 'section',
				fields: [
					{type: 'mrkdwn', text: '*a:* 1'},
					{type: 'mrkdwn', text: '*b:* {"c":2}'},
				],
			},
		]);
	});

	it('keeps ten fields and says how many more there were', () => {
		const ctx = Object.fromEntries(Array.from({length: 12}, (_, i) => [`k${i}`, i]));
		const payload = formatSlackPayload({channel: 'alerts', title: 'T', ctx}, 'C1');
		const fields = payload.blocks.find((b) => b.type === 'section');
		expect(fields && 'fields' in fields ? fields.fields?.length : 0).toBe(10);
		expect(payload.blocks.at(-1)).toEqual({
			type: 'context',
			elements: [{type: 'mrkdwn', text: '_…2 more field(s) omitted_'}],
		});
	});

	it('threads a reply', () => {
		expect(
			formatSlackPayload({channel: 'alerts', title: 'T', threadTs: '1.2'}, 'C1').thread_ts,
		).toBe('1.2');
	});
});

describe('createNotifier', () => {
	it('posts to the channel with the token and hands back the message', async () => {
		const posted: SlackPayload[] = [];
		const fetchSpy = stubFetch(async (_url, init) => {
			posted.push(JSON.parse(String(init?.body)) as SlackPayload);
			return Response.json({ok: true, ts: '171.5', channel: 'C1'});
		});
		const handle = await createNotifier(config).notify({channel: 'alerts', title: 'Hi'});
		expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://slack.com/api/chat.postMessage');
		expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
			'Bearer xoxb-test',
		);
		expect(posted[0]?.channel).toBe('C1');
		expect(handle).toEqual({ts: '171.5', channelId: 'C1'});
	});

	it('posts nothing without a token, writing it out in development', async () => {
		const fetchSpy = stubFetch(async () => Response.json({ok: true}));
		const log = spyOn(console, 'log').mockImplementation(() => {});
		const handle = await createNotifier({...config, botToken: '', env: 'development'}).notify({
			channel: 'alerts',
			title: 'Hi',
		});
		expect(handle).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(log.mock.calls[0]?.[0]).toBe('[notify:alerts:info:off(no_token)]');
	});

	it('reports what Slack refused', async () => {
		stubFetch(async () => Response.json({ok: false, error: 'channel_not_found'}));
		const onError = mock();
		const handle = await createNotifier(config, {onError}).notify({
			channel: 'signups',
			title: 'Hi',
		});
		expect(handle).toBeUndefined();
		expect(onError.mock.calls[0]?.[0]).toEqual({
			kind: 'slack_api_error',
			error: 'channel_not_found',
			warning: undefined,
		});
	});

	it('reports a transport failure', async () => {
		stubFetch(async () => new Response('down', {status: 503}));
		const onError = mock();
		await createNotifier(config, {onError}).notify({channel: 'alerts', title: 'Hi'});
		expect(onError.mock.calls[0]?.[0]).toMatchObject({kind: 'http', status: 503});
	});
});
