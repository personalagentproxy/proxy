import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test';

import {createMetricsClient} from './metrics';

type Attr = {key: string; value: {stringValue: string}};
type Payload = {
	resourceMetrics: Array<{
		resource: {attributes: Attr[]};
		scopeMetrics: Array<{metrics: Array<Record<string, unknown>>}>;
	}>;
};

function capturingFetch(payloads: Payload[], status = 200) {
	return spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (typeof init?.body === 'string') {
					payloads.push(JSON.parse(init.body) as Payload);
				}
				return new Response(null, {status});
			},
			{preconnect: fetch.preconnect},
		),
	);
}

const config = {
	url: 'http://otlp.test/v1/metrics',
	userId: 'u',
	token: 't',
	service: 'api' as const,
	env: 'production' as const,
	instanceId: 'i1',
	flushIntervalMs: 1_000_000,
};

afterEach(() => {
	mock.restore();
});

describe('createMetricsClient', () => {
	it('sends nothing without an address', async () => {
		const fetchSpy = capturingFetch([]);
		const metrics = createMetricsClient({...config, url: ''});
		metrics.counter('x_total').inc();
		await metrics.flush();
		expect(fetchSpy).not.toHaveBeenCalled();
		await metrics.shutdown();
	});

	it('sends nothing while no metric has a point', async () => {
		const fetchSpy = capturingFetch([]);
		const metrics = createMetricsClient(config);
		metrics.counter('x_total');
		await metrics.flush();
		expect(fetchSpy).not.toHaveBeenCalled();
		await metrics.shutdown();
	});

	it('sums counters by label set, cumulative across flushes, with the resource attributes', async () => {
		const payloads: Payload[] = [];
		capturingFetch(payloads);
		const metrics = createMetricsClient(config);
		const counter = metrics.counter('tool_calls_total', {description: 'calls'});
		counter.inc({surface: 'mcp'});
		counter.inc({surface: 'mcp'}, 2);
		counter.inc({surface: 'web'});
		await metrics.flush();
		counter.inc({surface: 'web'});
		await metrics.flush();

		expect(payloads).toHaveLength(2);
		const resource = payloads[0]!.resourceMetrics[0]!;
		expect(resource.resource.attributes).toEqual([
			{key: 'service.name', value: {stringValue: 'api'}},
			{key: 'service.instance.id', value: {stringValue: 'i1'}},
			{key: 'deployment.environment', value: {stringValue: 'production'}},
		]);
		const metric = resource.scopeMetrics[0]!.metrics[0] as {
			name: string;
			sum: {
				isMonotonic: boolean;
				aggregationTemporality: number;
				dataPoints: Array<{attributes: Attr[]; asDouble: number}>;
			};
		};
		expect(metric.name).toBe('tool_calls_total');
		expect(metric.sum.isMonotonic).toBe(true);
		expect(metric.sum.aggregationTemporality).toBe(2);
		expect(
			metric.sum.dataPoints.map((p) => [p.attributes[0]!.value.stringValue, p.asDouble]),
		).toEqual([
			['mcp', 3],
			['web', 1],
		]);
		const second = payloads[1]!.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0] as typeof metric;
		expect(second.sum.dataPoints[1]!.asDouble).toBe(2);
		await metrics.shutdown();
	});

	it('counts a histogram’s observations into its buckets', async () => {
		const payloads: Payload[] = [];
		capturingFetch(payloads);
		const metrics = createMetricsClient(config);
		const histogram = metrics.histogram('d', {unit: 'ms', buckets: [10, 100]});
		histogram.observe(5);
		histogram.observe(10);
		histogram.observe(50);
		histogram.observe(5000);
		await metrics.flush();
		const metric = payloads[0]!.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0] as {
			unit: string;
			histogram: {
				dataPoints: Array<{
					count: string;
					sum: number;
					bucketCounts: string[];
					explicitBounds: number[];
				}>;
			};
		};
		expect(metric.unit).toBe('ms');
		expect(metric.histogram.dataPoints[0]).toMatchObject({
			count: '4',
			sum: 5065,
			bucketCounts: ['2', '1', '1'],
			explicitBounds: [10, 100],
		});
		await metrics.shutdown();
	});

	it('keeps a gauge’s last value per label set', async () => {
		const payloads: Payload[] = [];
		capturingFetch(payloads);
		const metrics = createMetricsClient(config);
		const gauge = metrics.gauge('queue');
		gauge.set({status: 'queued'}, 3);
		gauge.set({status: 'queued'}, 1);
		await metrics.flush();
		const metric = payloads[0]!.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0] as {
			unit: string;
			gauge: {dataPoints: Array<{asDouble: number}>};
		};
		expect(metric.unit).toBe('');
		expect(metric.gauge.dataPoints).toHaveLength(1);
		expect(metric.gauge.dataPoints[0]!.asDouble).toBe(1);
		await metrics.shutdown();
	});

	it('reports a failed push and keeps counting', async () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		capturingFetch([], 400);
		const metrics = createMetricsClient(config);
		metrics.counter('x_total').inc();
		await metrics.flush();
		expect(errors).toHaveBeenCalledTimes(1);
		await metrics.shutdown();
	});
});

describe('where metrics go', () => {
	it('takes a Prometheus by its address alone, and a gateway by its whole URL', async () => {
		const urls: string[] = [];
		spyOn(globalThis, 'fetch').mockImplementation(
			Object.assign(
				async (url: string | URL | Request) => {
					urls.push(String(url));
					return new Response(null, {status: 200});
				},
				{preconnect: fetch.preconnect},
			),
		);
		for (const url of [
			'prometheus-ab12:9090',
			'http://prometheus:9090/',
			'https://otlp-gateway.grafana.net/otlp/v1/metrics',
		]) {
			const metrics = createMetricsClient({...config, url});
			metrics.counter('x_total').inc();
			await metrics.shutdown();
		}
		expect(urls).toEqual([
			'http://prometheus-ab12:9090/api/v1/otlp/v1/metrics',
			'http://prometheus:9090/api/v1/otlp/v1/metrics',
			'https://otlp-gateway.grafana.net/otlp/v1/metrics',
		]);
		mock.restore();
	});
});
