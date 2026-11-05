import {Err, Ok, Result} from 'ts-results-es';

import type {EnvLabel, ServiceLabel} from './types';

/**
 * Metrics, pushed to Grafana Cloud's OTLP gateway: counters, histograms and gauges are summed up
 * in the process and sent every half minute as one OTLP JSON payload, cumulative since the process
 * started, with the service, its instance and the environment as resource attributes. Without an
 * address nothing is sent, and recording costs a map lookup.
 */

// Histogram bucket bounds in milliseconds, for queries and requests whose most observations are
// under 100ms and whose tails reach seconds.
export const LATENCY_BUCKETS_MS: readonly number[] = [
	5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

export interface MetricsConfig {
	url: string;
	userId: string;
	token: string;
	service: ServiceLabel;
	env: EnvLabel;
	// Which process this is, so two instances pushing the same series don't read as counter resets.
	instanceId?: string;
	flushIntervalMs?: number;
}

export interface Counter {
	inc(labels?: Record<string, string>, value?: number): void;
}

export interface Histogram {
	observe(value: number, labels?: Record<string, string>): void;
}

export interface Gauge {
	/** Sets the gauge for one set of labels; each set is its own series. */
	set(labels: Record<string, string>, value: number): void;
}

type MetricOptions = {description?: string; unit?: string};

export interface MetricsClient {
	/** Whether there is an address to push to; nothing is summed up for long without one. */
	readonly enabled: boolean;
	counter(name: string, options?: MetricOptions): Counter;
	histogram(name: string, options?: MetricOptions & {buckets?: readonly number[]}): Histogram;
	gauge(name: string, options?: MetricOptions): Gauge;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

export type MetricsError =
	{kind: 'http_error'; status: number; body: string} | {kind: 'network_error'; cause: unknown};

function labelsKey(labels: Record<string, string>): string {
	return Object.keys(labels)
		.sort()
		.map((key) => `${key}=${labels[key]}`)
		.join('|');
}

function labelsToAttributes(
	labels: Record<string, string>,
): Array<{key: string; value: {stringValue: string}}> {
	return Object.entries(labels).map(([key, value]) => ({key, value: {stringValue: value}}));
}

interface CounterPoint {
	labels: Record<string, string>;
	value: number;
}

interface HistogramPoint {
	labels: Record<string, string>;
	count: number;
	sum: number;
	bucketCounts: number[];
}

interface GaugePoint {
	labels: Record<string, string>;
	value: number;
}

interface CounterState {
	kind: 'counter';
	description: string;
	unit: string;
	points: Map<string, CounterPoint>;
}

interface HistogramState {
	kind: 'histogram';
	description: string;
	unit: string;
	bounds: readonly number[];
	points: Map<string, HistogramPoint>;
}

interface GaugeState {
	kind: 'gauge';
	description: string;
	unit: string;
	points: Map<string, GaugePoint>;
}

type MetricState = CounterState | HistogramState | GaugeState;

// The index of the first bucket whose upper bound holds `value`; the last bucket has no bound.
function bucketIndex(value: number, bounds: readonly number[]): number {
	const index = bounds.findIndex((bound) => value <= bound);
	return index === -1 ? bounds.length : index;
}

const NS_PER_MS = BigInt(1_000_000);

function msToNs(ms: number): string {
	return (BigInt(ms) * NS_PER_MS).toString();
}

export function createMetricsClient(config: MetricsConfig): MetricsClient {
	const flushIntervalMs = config.flushIntervalMs ?? 30_000;
	const disabled = config.url.length === 0;
	const startTimeUnixNano = msToNs(Date.now());
	const instanceId = config.instanceId ?? crypto.randomUUID();
	const metrics = new Map<string, MetricState>();
	let isShutDown = false;
	let flushChain: Promise<void> = Promise.resolve();

	function getOrCreate<T extends MetricState>(name: string, create: () => T): T {
		const existing = metrics.get(name);
		if (existing) {
			return existing as T;
		}
		const created = create();
		metrics.set(name, created);
		return created;
	}

	function buildPayload(): Record<string, unknown> | null {
		const nowUnixNano = msToNs(Date.now());
		const otlpMetrics: Array<Record<string, unknown>> = [];

		for (const [name, state] of metrics) {
			// A metric nothing has been recorded on yet has no points, and the gateway refuses a
			// metric without any (HTTP 400).
			if (state.points.size === 0) {
				continue;
			}

			if (state.kind === 'counter') {
				otlpMetrics.push({
					name,
					description: state.description,
					unit: state.unit,
					sum: {
						aggregationTemporality: 2, // Cumulative.
						isMonotonic: true,
						dataPoints: Array.from(state.points.values()).map((p) => ({
							attributes: labelsToAttributes(p.labels),
							startTimeUnixNano,
							timeUnixNano: nowUnixNano,
							asDouble: p.value,
						})),
					},
				});
				continue;
			}

			if (state.kind === 'gauge') {
				otlpMetrics.push({
					name,
					description: state.description,
					unit: state.unit,
					gauge: {
						dataPoints: Array.from(state.points.values()).map((p) => ({
							attributes: labelsToAttributes(p.labels),
							timeUnixNano: nowUnixNano,
							asDouble: p.value,
						})),
					},
				});
				continue;
			}

			otlpMetrics.push({
				name,
				description: state.description,
				unit: state.unit,
				histogram: {
					aggregationTemporality: 2,
					dataPoints: Array.from(state.points.values()).map((p) => ({
						attributes: labelsToAttributes(p.labels),
						startTimeUnixNano,
						timeUnixNano: nowUnixNano,
						count: String(p.count),
						sum: p.sum,
						bucketCounts: p.bucketCounts.map(String),
						explicitBounds: state.bounds,
					})),
				},
			});
		}

		if (otlpMetrics.length === 0) {
			return null;
		}

		return {
			resourceMetrics: [
				{
					resource: {
						attributes: [
							{key: 'service.name', value: {stringValue: config.service}},
							{key: 'service.instance.id', value: {stringValue: instanceId}},
							{key: 'deployment.environment', value: {stringValue: config.env}},
						],
					},
					scopeMetrics: [{scope: {name: 'proxy'}, metrics: otlpMetrics}],
				},
			],
		};
	}

	async function push(payload: Record<string, unknown>): Promise<Result<void, MetricsError>> {
		const response = await Result.wrapAsync(() =>
			fetch(config.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					// Grafana Cloud's gateway takes the stack's id and a token; a Prometheus of your own
					// takes no auth.
					...(config.userId
						? {Authorization: `Basic ${btoa(`${config.userId}:${config.token}`)}`}
						: {}),
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(10_000),
			}),
		);
		if (response.isErr()) {
			return Err({kind: 'network_error', cause: response.error});
		}
		if (response.value.ok) {
			return Ok(undefined);
		}
		const text = await Result.wrapAsync(() => response.value.text());
		return Err({
			kind: 'http_error',
			status: response.value.status,
			body: text.isOk() ? text.value : '<unreadable>',
		});
	}

	async function doFlush(): Promise<void> {
		if (disabled) {
			return;
		}
		const payload = buildPayload();
		if (payload === null) {
			return;
		}
		const result = await push(payload);
		if (result.isOk()) {
			return;
		}
		const detail =
			result.error.kind === 'http_error'
				? `HTTP ${result.error.status}: ${result.error.body}`
				: `network error: ${String(result.error.cause)}`;
		console.error('[observability] metrics push failed:', detail);
	}

	function flush(): Promise<void> {
		flushChain = flushChain.then(doFlush, doFlush);
		return flushChain;
	}

	const interval = disabled ? undefined : setInterval(() => void flush(), flushIntervalMs);
	interval?.unref();

	async function shutdown(): Promise<void> {
		if (isShutDown) {
			return;
		}
		isShutDown = true;
		clearInterval(interval);
		await flush();
	}

	if (!disabled && typeof process !== 'undefined' && typeof process.once === 'function') {
		process.once('beforeExit', () => void shutdown());
	}

	function counter(name: string, options?: MetricOptions): Counter {
		const state = getOrCreate<CounterState>(name, () => ({
			kind: 'counter',
			description: options?.description ?? '',
			unit: options?.unit ?? '1',
			points: new Map(),
		}));
		return {
			inc(labels = {}, value = 1) {
				const key = labelsKey(labels);
				const existing = state.points.get(key);
				if (existing) {
					existing.value += value;
					return;
				}
				state.points.set(key, {labels: {...labels}, value});
			},
		};
	}

	function histogram(
		name: string,
		options?: MetricOptions & {buckets?: readonly number[]},
	): Histogram {
		const bounds = options?.buckets ?? LATENCY_BUCKETS_MS;
		const state = getOrCreate<HistogramState>(name, () => ({
			kind: 'histogram',
			description: options?.description ?? '',
			unit: options?.unit ?? '',
			bounds,
			points: new Map(),
		}));
		return {
			observe(value, labels = {}) {
				const key = labelsKey(labels);
				const point = state.points.get(key) ?? {
					labels: {...labels},
					count: 0,
					sum: 0,
					bucketCounts: new Array<number>(bounds.length + 1).fill(0),
				};
				state.points.set(key, point);
				point.count += 1;
				point.sum += value;
				const index = bucketIndex(value, bounds);
				point.bucketCounts[index] = (point.bucketCounts[index] ?? 0) + 1;
			},
		};
	}

	function gauge(name: string, options?: MetricOptions): Gauge {
		// No unit by default: Grafana Cloud's OTLP normalizer suffixes a gauge with unit `1`, the
		// OTLP word for a plain number, as `<name>_ratio`, which no query would expect. Counters
		// keep `1`, since their `_total` suffix shields them from that rule.
		const state = getOrCreate<GaugeState>(name, () => ({
			kind: 'gauge',
			description: options?.description ?? '',
			unit: options?.unit ?? '',
			points: new Map(),
		}));
		return {
			set(labels, value) {
				state.points.set(labelsKey(labels), {labels: {...labels}, value});
			},
		};
	}

	return {enabled: !disabled, counter, histogram, gauge, flush, shutdown};
}
