import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import packageJson from '../../../../package.json';
import {envSchema} from '../utils/env-schema';

const getOrCreateInstanceMetaValue = mock();
const runInstanceMetaTaskIfStale = mock();

mock.module('@proxy/db/instance-meta', () => ({
	getOrCreateInstanceMetaValue,
	runInstanceMetaTaskIfStale,
}));

const debug = mock();
const info = mock();
mock.module('../observability/log', () => ({
	log: {debug, info, warn: mock(), error: mock()},
}));

const mockEnv = {
	NODE_ENV: 'production',
	CI: undefined as string | undefined,
	TELEMETRY_ENABLED: true,
	TELEMETRY_ENDPOINT: 'https://telemetry.example.test/heartbeat',
	TELEMETRY_API_KEY: 'phc_test',
	APP_VERSION: '',
};

mock.module('../utils/env', () => ({env: mockEnv}));

const {sendTelemetryHeartbeat} = await import('.');

type RecordedRequest = {input: string; init: RequestInit};
type RecordedPostHogPayload = {
	api_key: string;
	event: string;
	distinct_id: string;
	timestamp: string;
	properties: Record<string, string | boolean>;
};

function recordingFetch(requests: RecordedRequest[]): (input: string, init: RequestInit) => Promise<Response> {
	return async (input, init) => {
		requests.push({input, init});
		return new Response(null, {status: 204});
	};
}

function requestPayload(request: RecordedRequest): RecordedPostHogPayload {
	const body = request.init?.body;
	if (typeof body !== 'string') {
		throw new Error('Expected the telemetry request body to be a string');
	}
	return JSON.parse(body) as RecordedPostHogPayload;
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.NODE_ENV = 'production';
	mockEnv.CI = undefined;
	mockEnv.TELEMETRY_ENABLED = true;
	mockEnv.TELEMETRY_ENDPOINT = 'https://telemetry.example.test/heartbeat';
	mockEnv.TELEMETRY_API_KEY = 'phc_test';
	mockEnv.APP_VERSION = '';
	getOrCreateInstanceMetaValue.mockResolvedValue(Ok('123e4567-e89b-42d3-a456-426614174000'));
	runInstanceMetaTaskIfStale.mockImplementation(async (_key: string, _value: string, _staleBefore: string, task: () => Promise<boolean>) => Ok((await task()) ? 'completed' : 'failed'));
});

describe('anonymous telemetry heartbeat', () => {
	test('defaults telemetry on and accepts both opt-out values', () => {
		const enabled = envSchema.shape.TELEMETRY_ENABLED;
		expect(enabled.parse(undefined)).toBe(true);
		expect(enabled.parse('false')).toBe(false);
		expect(enabled.parse('0')).toBe(false);
	});

	test('posts the heartbeat as an anonymous PostHog event with only the allowed usage data', async () => {
		const requests: RecordedRequest[] = [];
		const now = new Date('2026-10-08T12:34:56.000Z');

		await sendTelemetryHeartbeat({
			now: () => now,
			newInstanceId: () => 'candidate-id',
			fetch: recordingFetch(requests),
		});

		expect(requests).toHaveLength(1);
		const payload = requestPayload(requests[0]!);
		expect(Object.keys(payload).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'timestamp']);
		expect(payload).toEqual({
			api_key: 'phc_test',
			event: 'instance heartbeat',
			distinct_id: '123e4567-e89b-42d3-a456-426614174000',
			timestamp: now.toISOString(),
			properties: {
				version: packageJson.version,
				$process_person_profile: false,
				$geoip_disable: true,
			},
		});
	});

	test('uses the version embedded in an official image', async () => {
		mockEnv.APP_VERSION = 'sha-1234567';
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({fetch: recordingFetch(requests)});

		expect(requestPayload(requests[0]!).properties.version).toBe('sha-1234567');
	});

	test('opt-out sends nothing and creates no instance id', async () => {
		mockEnv.TELEMETRY_ENABLED = false;
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({fetch: recordingFetch(requests)});

		expect(requests).toHaveLength(0);
		expect(getOrCreateInstanceMetaValue).not.toHaveBeenCalled();
		expect(runInstanceMetaTaskIfStale).not.toHaveBeenCalled();
	});

	test('an empty endpoint leaves telemetry dormant without creating an instance id', async () => {
		mockEnv.TELEMETRY_ENDPOINT = '';
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({fetch: recordingFetch(requests)});

		expect(requests).toHaveLength(0);
		expect(getOrCreateInstanceMetaValue).not.toHaveBeenCalled();
		expect(runInstanceMetaTaskIfStale).not.toHaveBeenCalled();
	});

	test('an empty PostHog project token leaves telemetry dormant without creating an instance id', async () => {
		mockEnv.TELEMETRY_API_KEY = '';
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({fetch: recordingFetch(requests)});

		expect(requests).toHaveLength(0);
		expect(getOrCreateInstanceMetaValue).not.toHaveBeenCalled();
		expect(runInstanceMetaTaskIfStale).not.toHaveBeenCalled();
	});

	test('skips development and CI without creating an instance id', async () => {
		for (const mode of ['development', 'ci'] as const) {
			mockEnv.NODE_ENV = mode === 'development' ? 'development' : 'production';
			mockEnv.CI = mode === 'ci' ? 'true' : undefined;

			await sendTelemetryHeartbeat({fetch: recordingFetch([])});
		}

		expect(getOrCreateInstanceMetaValue).not.toHaveBeenCalled();
		expect(runInstanceMetaTaskIfStale).not.toHaveBeenCalled();
	});

	test('keeps the same instance id across calls', async () => {
		let storedId: string | undefined;
		getOrCreateInstanceMetaValue.mockImplementation(async (_key: string, candidate: string) => {
			storedId ??= candidate;
			return Ok(storedId);
		});
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({
			now: () => new Date('2026-10-08T00:00:00.000Z'),
			newInstanceId: () => 'first-candidate',
			fetch: recordingFetch(requests),
		});
		await sendTelemetryHeartbeat({
			now: () => new Date('2026-10-09T00:00:00.000Z'),
			newInstanceId: () => 'second-candidate',
			fetch: recordingFetch(requests),
		});

		expect(requests.map(requestPayload).map((payload) => payload.distinct_id)).toEqual(['first-candidate', 'first-candidate']);
	});

	test('absorbs a failed fetch', async () => {
		const failedFetch = async (): Promise<Response> => {
			throw new Error('network unavailable');
		};

		await sendTelemetryHeartbeat({fetch: failedFetch});

		expect(debug).toHaveBeenCalledWith('Anonymous telemetry heartbeat failed');
	});

	test('skips a heartbeat sent less than 23 hours ago', async () => {
		const now = new Date('2026-10-08T12:00:00.000Z');
		runInstanceMetaTaskIfStale.mockResolvedValue(Ok('skipped'));
		const requests: RecordedRequest[] = [];

		await sendTelemetryHeartbeat({now: () => now, fetch: recordingFetch(requests)});

		expect(requests).toHaveLength(0);
		expect(runInstanceMetaTaskIfStale).toHaveBeenCalledWith('telemetry_last_sent_at', now.toISOString(), new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString(), expect.any(Function));
	});

	test('lets only one process send when two heartbeats run concurrently', async () => {
		let locked = false;
		let releaseFetch: (() => void) | undefined;
		const fetchStarted = Promise.withResolvers<void>();
		const fetchReleased = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		runInstanceMetaTaskIfStale.mockImplementation(async (_key: string, _value: string, _staleBefore: string, task: () => Promise<boolean>) => {
			if (locked) {
				return Ok('skipped');
			}

			locked = true;
			const succeeded = await task();
			locked = false;
			return Ok(succeeded ? 'completed' : 'failed');
		});
		const requests: RecordedRequest[] = [];
		const fetch = async (input: string, init: RequestInit): Promise<Response> => {
			requests.push({input, init});
			fetchStarted.resolve();
			await fetchReleased;
			return new Response(null, {status: 204});
		};

		const first = sendTelemetryHeartbeat({fetch});
		await fetchStarted.promise;
		const second = sendTelemetryHeartbeat({fetch});
		await second;
		releaseFetch?.();
		await first;

		expect(requests).toHaveLength(1);
	});
});
