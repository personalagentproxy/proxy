import type {Histogram, MetricsClient} from './metrics';

/** Anything with `$queryRaw`, so this package needs nothing of the database package. */
export interface DbProbeClient {
	$queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
}

export interface DbPoolProbeOptions {
	db: DbProbeClient;
	metrics: MetricsClient;
	intervalMs?: number;
}

/**
 * Runs `SELECT 1` on a fixed interval, outside any transaction, and records how long it took as
 * `db_pool_wait_probe`. The server's part of `SELECT 1` is under a millisecond, so what is
 * measured is waiting for a connection of the pool, the network and the event loop: it spikes
 * when the pool is saturated or the loop is blocked, which `db_query_duration`, the server's
 * side, doesn't show. One probe at a time, so a slow one doesn't pile up; a failure is recorded
 * as its duration and never reaches the host.
 */
export function startDbPoolProbe({
	db,
	metrics,
	intervalMs = 1_000,
}: DbPoolProbeOptions): () => void {
	const histogram: Histogram = metrics.histogram('db_pool_wait_probe', {
		description:
			'How long a no-op SELECT 1 took on a fixed interval: waiting for the pool, the network and the event loop',
		unit: 'ms',
	});

	let inFlight = false;

	async function tick(): Promise<void> {
		if (inFlight) {
			return;
		}
		inFlight = true;
		const start = performance.now();
		try {
			await db.$queryRaw`SELECT 1`;
		} catch {
			// Diagnostic only. The duration is still recorded: a pool timeout is the loudest sign
			// of saturation, and the metric shouldn't go quiet just then.
		} finally {
			histogram.observe(Math.round(performance.now() - start));
			inFlight = false;
		}
	}

	void tick();
	const interval = setInterval(() => void tick(), intervalMs);
	interval.unref();
	return () => clearInterval(interval);
}
