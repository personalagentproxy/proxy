import {randomUUID} from 'node:crypto';

import {getOrCreateInstanceMetaValue, runInstanceMetaTaskIfStale} from '@proxy/db/instance-meta';
import {Result} from 'ts-results-es';

import packageJson from '../../../../package.json';
import {log} from '../observability/log';
import {env} from '../utils/env';

const INSTANCE_ID_KEY = 'telemetry_instance_id';
const LAST_SENT_AT_KEY = 'telemetry_last_sent_at';
const INITIAL_DELAY_MS = 60_000;
const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MINIMUM_SEND_INTERVAL_MS = 23 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

type TelemetryHeartbeat = {
	instanceId: string;
	version: string;
	timestamp: string;
};

type PostHogPayload = {
	api_key: string;
	event: 'instance heartbeat';
	distinct_id: string;
	timestamp: string;
	properties: {
		version: string;
		$process_person_profile: false;
		$geoip_disable: true;
	};
};

type TelemetryFetch = (input: string, init: RequestInit) => Promise<Response>;

type SendOptions = {
	now?: () => Date;
	newInstanceId?: () => string;
	fetch?: TelemetryFetch;
};

let hasStarted = false;
let hasLoggedDormant = false;

function isEnabledAndConfigured(): boolean {
	return env.NODE_ENV === 'production' && !env.CI && env.TELEMETRY_ENABLED && env.TELEMETRY_ENDPOINT.length > 0 && env.TELEMETRY_API_KEY.length > 0;
}

function logFailure(message: string): void {
	log.debug(message);
}

async function sendTelemetryHeartbeatUnsafe(options: SendOptions): Promise<void> {
	if (!isEnabledAndConfigured()) {
		return;
	}

	const now = options.now?.() ?? new Date();
	const candidateId = options.newInstanceId?.() ?? randomUUID();
	const instanceIdResult = await getOrCreateInstanceMetaValue(INSTANCE_ID_KEY, candidateId);
	if (instanceIdResult.isErr()) {
		logFailure('Could not create anonymous telemetry instance id');
		return;
	}

	const heartbeat: TelemetryHeartbeat = {
		instanceId: instanceIdResult.value,
		version: env.APP_VERSION || packageJson.version,
		timestamp: now.toISOString(),
	};
	const payload: PostHogPayload = {
		api_key: env.TELEMETRY_API_KEY,
		event: 'instance heartbeat',
		distinct_id: heartbeat.instanceId,
		timestamp: heartbeat.timestamp,
		properties: {
			version: heartbeat.version,
			$process_person_profile: false,
			$geoip_disable: true,
		},
	};

	const staleBefore = new Date(now.getTime() - MINIMUM_SEND_INTERVAL_MS).toISOString();
	const taskResult = await runInstanceMetaTaskIfStale(LAST_SENT_AT_KEY, heartbeat.timestamp, staleBefore, async () => {
		const fetchTelemetry = options.fetch ?? globalThis.fetch;
		const responseResult = await Result.wrapAsync(() =>
			fetchTelemetry(env.TELEMETRY_ENDPOINT, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		);
		if (responseResult.isErr()) {
			logFailure('Anonymous telemetry heartbeat failed');
			return false;
		}

		if (!responseResult.value.ok) {
			log.debug('Anonymous telemetry collector rejected a heartbeat', {status: responseResult.value.status});
			return false;
		}

		return true;
	});
	if (taskResult.isErr()) {
		logFailure('Could not read or save anonymous telemetry state');
	}
}

/** Sends at most one heartbeat and absorbs every failure. Exported for focused tests. */
export async function sendTelemetryHeartbeat(options: SendOptions = {}): Promise<void> {
	try {
		await sendTelemetryHeartbeatUnsafe(options);
	} catch {
		logFailure('Anonymous telemetry heartbeat failed');
	}
}

/** Starts the non-blocking daily heartbeat after Prisma is ready. */
export function startTelemetry(): void {
	try {
		if (env.NODE_ENV !== 'production' || env.CI || !env.TELEMETRY_ENABLED) {
			return;
		}

		if (!env.TELEMETRY_ENDPOINT || !env.TELEMETRY_API_KEY) {
			if (!hasLoggedDormant) {
				log.debug('Anonymous telemetry is dormant because its PostHog endpoint or project token is empty');
				hasLoggedDormant = true;
			}
			return;
		}

		if (hasStarted) {
			return;
		}
		hasStarted = true;

		log.info('Anonymous telemetry is enabled. Set TELEMETRY_ENABLED=false to disable. See docs.');

		const initial = setTimeout(() => {
			void sendTelemetryHeartbeat();
		}, INITIAL_DELAY_MS);
		initial.unref();

		const daily = setInterval(() => {
			void sendTelemetryHeartbeat();
		}, SEND_INTERVAL_MS);
		daily.unref();
	} catch {
		logFailure('Could not start anonymous telemetry');
	}
}
