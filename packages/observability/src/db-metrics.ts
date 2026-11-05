import type {DbMetrics} from '@proxy/utils';

import type {Counter, Histogram, MetricsClient} from './metrics';

/**
 * What `wrapDb` records of every query: a count and a duration by whether it succeeded, two
 * series each, and failures by their kind of error on a counter of their own, so a new kind can't
 * grow the main ones.
 */
export function createDbMetricsRecorder(client: MetricsClient): DbMetrics {
	const queries: Counter = client.counter('db_queries_total', {
		description: 'Queries run through wrapDb',
	});
	const duration: Histogram = client.histogram('db_query_duration', {
		description: 'How long a query took',
		unit: 'ms',
	});
	const errors: Counter = client.counter('db_query_errors_total', {
		description: 'Failed queries by kind of error',
	});

	return {
		recordQuery({success, durationMs, errorKind}) {
			const labels = {success: success ? 'true' : 'false'};
			queries.inc(labels);
			duration.observe(durationMs, labels);
			if (!success && errorKind) {
				errors.inc({kind: errorKind});
			}
		},
	};
}
