import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {envSchema} from '../utils/env-schema';

const getOrCreateInstanceMetaValue = mock();
mock.module('@proxy/db/instance-meta', () => ({getOrCreateInstanceMetaValue}));

const info = mock();
mock.module('../observability/log', () => ({
	log: {debug: mock(), info, warn: mock(), error: mock()},
}));

const mockEnv = {
	NODE_ENV: 'production',
	TELEMETRY_ENABLED: true,
	APP_VERSION: 'sha-1234567',
};
mock.module('../utils/env', () => ({env: mockEnv}));

const fetchSpy = spyOn(globalThis, 'fetch');

const {sendTelemetryHeartbeat, startTelemetry} = await import('.');

beforeEach(() => {
	mock.clearAllMocks();
	fetchSpy.mockResolvedValue(new Response(null, {status: 200}));
	mockEnv.NODE_ENV = 'production';
	mockEnv.TELEMETRY_ENABLED = true;
	getOrCreateInstanceMetaValue.mockResolvedValue(Ok('123e4567-e89b-42d3-a456-426614174000'));
});

afterAll(() => {
	fetchSpy.mockRestore();
});

describe('anonymous telemetry heartbeat', () => {
	test('is on by default and turns off with false or 0', () => {
		const enabled = envSchema.shape.TELEMETRY_ENABLED;
		expect(enabled.parse(undefined)).toBe(true);
		expect(enabled.parse('false')).toBe(false);
		expect(enabled.parse('0')).toBe(false);
	});

	test('sends only the instance id, the version and the time', async () => {
		await sendTelemetryHeartbeat();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
		expect(body).toEqual({
			api_key: expect.stringMatching(/^phc_/),
			event: 'instance heartbeat',
			distinct_id: '123e4567-e89b-42d3-a456-426614174000',
			timestamp: expect.any(String),
			properties: {version: 'sha-1234567', $process_person_profile: false, $geoip_disable: true},
		});
	});

	test('a failed request does not throw', async () => {
		fetchSpy.mockRejectedValue(new Error('network unavailable'));

		await expect(sendTelemetryHeartbeat()).resolves.toBeUndefined();
	});

	test('does not start when turned off or outside production', () => {
		mockEnv.TELEMETRY_ENABLED = false;
		startTelemetry();
		mockEnv.TELEMETRY_ENABLED = true;
		mockEnv.NODE_ENV = 'development';
		startTelemetry();

		expect(info).not.toHaveBeenCalled();
	});
});
