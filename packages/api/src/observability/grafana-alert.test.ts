import {beforeEach, describe, expect, it, mock} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import type {FetchError} from '@proxy/utils';
import type {LokiQueryResult, NotifyHandle, NotifyInput} from '@proxy/observability';

// The secret's check lives beside the sign-in's, which reads the whole environment on import.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'development'}}));
mock.module('./config', () => ({
	envLabel: 'development',
	lokiConfig: {url: '', userId: '', token: ''},
	metricsConfig: {url: '', userId: '', token: ''},
	slackConfig: {botToken: '', channels: {}},
	grafanaWebhookSecret: 'shh',
}));
mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));
mock.module('@proxy/db/organization', () => ({listOrganizationSlugs: mock(async () => Ok([]))}));

const {handleGrafanaAlertRoute, mergeAlert, postAlertWithThread, toNotifyInput} = await import('./grafana-alert');
type Deps = NonNullable<Parameters<typeof postAlertWithThread>[1]>;

const firing = {
	status: 'firing' as const,
	labels: {alertname: 'Any production error', channel: 'alerts', severity: 'error'},
	annotations: {summary: 'Errors in production', description: 'Some lines', lokiQuery: '{env="production", level="error"}'},
	startsAt: '2026-11-04T10:00:00.000Z',
	generatorURL: 'https://grafana.example/alerting/x',
};

function streamsResult(lines: Array<Record<string, unknown>>): LokiQueryResult {
	return {
		status: 'success',
		data: {
			resultType: 'streams',
			result: [{stream: {service: 'api'}, values: lines.map((line, i) => [String(i), JSON.stringify(line)])}],
		},
	};
}

function deps(overrides: Partial<Deps> = {}) {
	const posted: NotifyInput[] = [];
	const notifier = {
		notify: mock(async (input: NotifyInput): Promise<NotifyHandle | undefined> => {
			posted.push(input);
			return {ts: `${posted.length}.0`, channelId: 'C1'};
		}),
	};
	const queryLoki = mock<Deps['queryLoki']>(async () => Ok(streamsResult([{msg: 'request failed', kind: 'db_error', orgId: 'o1'}])));
	const logWarn = mock<Deps['logWarn']>(() => {});
	const deps: Deps = {
		notifier,
		queryLoki,
		lokiConfig: {url: 'http://loki', userId: 'u', token: 't'},
		resolveOrgSlugs: mock(async () => new Map([['o1', 'acme']])),
		now: () => Date.parse('2026-11-04T10:01:00.000Z'),
		logWarn,
		...overrides,
	};
	return {posted, queryLoki, logWarn, deps};
}

describe('toNotifyInput', () => {
	it('titles the message with the summary, to the labelled channel, at the labelled severity', () => {
		expect(toNotifyInput(firing)).toEqual({
			channel: 'alerts',
			title: 'Errors in production',
			body: 'Some lines',
			severity: 'error',
			ctx: {
				alertname: 'Any production error',
				status: 'firing',
				severity: 'error',
				startsAt: firing.startsAt,
				url: firing.generatorURL,
			},
		});
	});

	it('marks a resolved alert as good news', () => {
		const input = toNotifyInput({...firing, status: 'resolved'});
		expect(input.title).toBe('[RESOLVED] Errors in production');
		expect(input.severity).toBe('info');
	});

	it('falls back to the alerts channel and the alert’s name', () => {
		const input = toNotifyInput({status: 'firing', labels: {alertname: 'x', channel: 'nope'}});
		expect(input.channel).toBe('alerts');
		expect(input.title).toBe('x');
	});
});

describe('mergeAlert', () => {
	it('folds the group’s labels and annotations in, the alert’s own winning', () => {
		const merged = mergeAlert({status: 'firing', labels: {a: '1'}}, {a: '0', b: '2'}, {lokiQuery: 'q'});
		expect(merged.labels).toEqual({a: '1', b: '2'});
		expect(merged.annotations).toEqual({lokiQuery: 'q'});
	});
});

describe('postAlertWithThread', () => {
	it('posts the alert, then the lines that tripped it in its thread, organizations named', async () => {
		const {posted, queryLoki, deps: d} = deps();
		await postAlertWithThread(firing, d);
		expect(posted).toHaveLength(2);
		expect(posted[1]).toMatchObject({channel: 'alerts', threadTs: '1.0', severity: 'info', title: '1 log line in 1 group'});
		expect(posted[1]?.body).toContain('*org:* acme');
		const params = queryLoki.mock.calls[0]?.[1];
		expect(params?.query).toBe(firing.annotations.lokiQuery);
		// Five minutes before it started, to a minute after.
		expect(params?.startNs).toBe(BigInt(Date.parse('2026-11-04T09:55:00.000Z')) * 1_000_000n);
		expect(params?.endNs).toBe(BigInt(Date.parse('2026-11-04T10:01:00.000Z')) * 1_000_000n);
	});

	it('posts a resolved alert alone', async () => {
		const {posted, queryLoki, deps: d} = deps();
		await postAlertWithThread({...firing, status: 'resolved'}, d);
		expect(posted).toHaveLength(1);
		expect(queryLoki).not.toHaveBeenCalled();
	});

	it('logs a Loki failure instead of throwing', async () => {
		const {posted, logWarn, deps: d} = deps({queryLoki: async () => Err<FetchError>({kind: 'network', url: 'x', cause: 'down'})});
		await postAlertWithThread(firing, d);
		expect(posted).toHaveLength(1);
		expect(logWarn).toHaveBeenCalledWith('alert thread: loki query failed', expect.objectContaining({lokiQuery: firing.annotations.lokiQuery}));
	});

	it('replies with nothing when no line matched', async () => {
		const {posted, deps: d} = deps({queryLoki: async () => Ok(streamsResult([]))});
		await postAlertWithThread(firing, d);
		expect(posted).toHaveLength(1);
	});
});

describe('handleGrafanaAlertRoute', () => {
	let status: number;
	let body: unknown;
	const res = {
		status: (code: number) => {
			status = code;
			return res;
		},
		json: (value: unknown) => {
			body = value;
		},
		end: () => {},
	};

	beforeEach(() => {
		status = 0;
		body = undefined;
	});

	function req(authorization: string | undefined, payload: unknown) {
		return {headers: authorization === undefined ? {} : {authorization}, body: payload} as unknown as Parameters<typeof handleGrafanaAlertRoute>[0];
	}

	it('refuses a call without the secret', async () => {
		await handleGrafanaAlertRoute(req('Bearer wrong', {status: 'firing', alerts: []}), res as never);
		expect(status).toBe(401);
		await handleGrafanaAlertRoute(req(undefined, {}), res as never);
		expect(status).toBe(401);
	});

	it('refuses a payload that is not Grafana’s', async () => {
		await handleGrafanaAlertRoute(req('Bearer shh', {nope: true}), res as never);
		expect(status).toBe(400);
		expect(body).toEqual({error: 'parse_error'});
	});

	it('takes the alerts and answers at once', async () => {
		await handleGrafanaAlertRoute(req('Bearer shh', {status: 'firing', alerts: [{status: 'firing', labels: {alertname: 'x'}}]}), res as never);
		expect(status).toBe(204);
	});
});
