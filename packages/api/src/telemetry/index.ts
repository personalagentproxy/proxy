import {randomUUID} from 'node:crypto';

import {getOrCreateInstanceMetaValue} from '@proxy/db/instance-meta';
import {Result} from 'ts-results-es';

import {log} from '../observability/log';
import {env} from '../utils/env';

// A PostHog project token can only send events, so it is fine in the source.
const POSTHOG_URL = 'https://us.i.posthog.com/i/v0/e/';
const POSTHOG_TOKEN = 'phc_maYvGChXKSWz8xcjLLAHSiweTNZhyWYoHRU3Gjrsxe32';
const INSTANCE_ID_KEY = 'telemetry_instance_id';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sends the installation's random id, its version and the time. Exported for the tests. */
export async function sendTelemetryHeartbeat(): Promise<void> {
	const instanceId = await getOrCreateInstanceMetaValue(INSTANCE_ID_KEY, randomUUID());
	if (instanceId.isErr()) {
		return;
	}

	const response = await Result.wrapAsync(() =>
		fetch(POSTHOG_URL, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({
				api_key: POSTHOG_TOKEN,
				event: 'instance heartbeat',
				distinct_id: instanceId.value,
				timestamp: new Date().toISOString(),
				properties: {version: env.APP_VERSION, $process_person_profile: false, $geoip_disable: true},
			}),
			signal: AbortSignal.timeout(5_000),
		}),
	);
	if (response.isErr() || !response.value.ok) {
		log.debug('Anonymous telemetry heartbeat failed');
	}
}

/** In production, unless turned off: a heartbeat a minute after the api starts, then once a day. */
export function startTelemetry(): void {
	if (env.NODE_ENV !== 'production' || !env.TELEMETRY_ENABLED) {
		return;
	}

	log.info('Anonymous telemetry is on. Set TELEMETRY_ENABLED=false to turn it off: https://docs.personalagentproxy.com/self-hosting/telemetry/');
	setTimeout(() => void sendTelemetryHeartbeat(), 60_000).unref();
	setInterval(() => void sendTelemetryHeartbeat(), DAY_MS).unref();
}
