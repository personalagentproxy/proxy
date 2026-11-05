import type {DbProbeClient} from './db-pool-probe';
import type {Gauge, MetricsClient} from './metrics';

export interface JobQueueProbeOptions {
	db: DbProbeClient;
	metrics: MetricsClient;
	// 10s by default: a count over an indexed column, cheap enough to show a spike as it happens.
	intervalMs?: number;
}

// Queued and running are what a backlog is made of; done and failed grow without end and belong
// on counters (agent_jobs_total, recorded by the worker).
const TRACKED_STATUSES = ['queued', 'running'] as const;
type TrackedStatus = (typeof TRACKED_STATUSES)[number];

type StatusRow = {kind: string; status: TrackedStatus; count: bigint};

/**
 * Reads the built-in agent's job queue (AgentJob) on a fixed interval: how many jobs are queued
 * and running, by kind, as `agent_jobs_queue`; how long the oldest due job has waited, as
 * `agent_jobs_queued_oldest_age`; and how long the oldest running job has run, as
 * `agent_jobs_running_oldest_age`. A backlog that keeps growing means the workers can't keep up;
 * a running age past the lease means a job is stuck. Every tracked series is set each tick, to
 * zero where nothing matched, so a drained queue doesn't stay at its last value. Failures never
 * reach the host.
 */
export function startJobQueueProbe({
	db,
	metrics,
	intervalMs = 10_000,
}: JobQueueProbeOptions): () => void {
	const queue: Gauge = metrics.gauge('agent_jobs_queue', {
		description:
			'Built-in agent jobs by kind and status, queued or running, counted on a fixed interval',
	});
	const queuedAge: Gauge = metrics.gauge('agent_jobs_queued_oldest_age', {
		description: 'Seconds the oldest due, still queued, built-in agent job has waited; 0 when none',
		unit: 's',
	});
	const runningAge: Gauge = metrics.gauge('agent_jobs_running_oldest_age', {
		description:
			'Seconds since the oldest running built-in agent job was claimed; 0 when none is running',
		unit: 's',
	});

	let inFlight = false;
	const seenKinds = new Set<string>();

	async function tick(): Promise<void> {
		if (inFlight) {
			return;
		}
		inFlight = true;
		try {
			const rows = await db.$queryRaw<StatusRow[]>`
				SELECT "kind"::text AS kind, "status"::text AS status, count(*)::bigint AS count
				FROM "AgentJob"
				WHERE "status" IN ('queued', 'running')
				GROUP BY "kind", "status"
			`;
			const counts = new Map<string, number>();
			for (const row of rows) {
				seenKinds.add(row.kind);
				counts.set(`${row.kind}|${row.status}`, Number(row.count));
			}
			for (const kind of seenKinds) {
				for (const status of TRACKED_STATUSES) {
					queue.set({kind, status}, counts.get(`${kind}|${status}`) ?? 0);
				}
			}

			const ages = await db.$queryRaw<Array<{queued: number; running: number}>>`
				SELECT
					COALESCE((SELECT EXTRACT(EPOCH FROM (now() - MIN("runAt"))) FROM "AgentJob" WHERE "status" = 'queued' AND "runAt" <= now()), 0)::float AS queued,
					COALESCE((SELECT EXTRACT(EPOCH FROM (now() - MIN("updatedAt"))) FROM "AgentJob" WHERE "status" = 'running'), 0)::float AS running
			`;
			queuedAge.set({}, Math.max(0, Number(ages[0]?.queued ?? 0)));
			runningAge.set({}, Math.max(0, Number(ages[0]?.running ?? 0)));
		} catch {
			// Diagnostic only; a database outage already shows on db_query_errors_total.
		} finally {
			inFlight = false;
		}
	}

	void tick();
	const interval = setInterval(() => void tick(), intervalMs);
	interval.unref();
	return () => clearInterval(interval);
}
