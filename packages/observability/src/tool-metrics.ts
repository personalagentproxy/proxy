import type {Counter, Histogram, MetricsClient} from './metrics';

/** How a request of an agent came in: the web app, the MCP server, or the built-in agent. */
export type ToolSurface = 'web' | 'mcp' | 'harness';

export type ToolOutcome = 'allowed' | 'denied' | 'failed';

export interface ToolCallSample {
	surface: ToolSurface;
	// The integration the connection is of, such as `google` or `postgres`; never the connection.
	integration: string;
	// The collection's operation, such as `list` or `send`; for a custom server's tools, their
	// action, since their names are the server's own.
	action: string;
	outcome: ToolOutcome;
	durationMs: number;
	// The api's kind of error, for a failed call.
	errorKind?: string;
}

export interface ToolMetrics {
	recordToolCall(sample: ToolCallSample): void;
}

/**
 * What every request of an agent records, beside its entry in the activity log: a count and a
 * duration by surface, integration, action and outcome, and failures by kind of error on a
 * counter of their own. Every label is from a bounded set, so the series stay few.
 */
export function createToolMetrics(client: MetricsClient): ToolMetrics {
	const calls: Counter = client.counter('tool_calls_total', {
		description: 'Requests of agents by surface, integration, action and outcome',
	});
	const duration: Histogram = client.histogram('tool_call_duration', {
		description: 'How long a request of an agent took',
		unit: 'ms',
	});
	const errors: Counter = client.counter('tool_call_errors_total', {
		description: 'Failed requests of agents by kind of error',
	});

	return {
		recordToolCall({surface, integration, action, outcome, durationMs, errorKind}) {
			const labels = {surface, integration, action, outcome};
			calls.inc(labels);
			duration.observe(durationMs, labels);
			if (outcome === 'failed') {
				errors.inc({surface, integration, kind: errorKind ?? 'unknown'});
			}
		},
	};
}
