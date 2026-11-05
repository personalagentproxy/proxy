import type {Counter, Histogram, MetricsClient} from './metrics';

/** How a built-in agent's job ended: done, failed as the job said, or thrown out of. */
export type AgentJobStatus = 'done' | 'failed' | 'thrown';

export interface AgentJobSample {
	kind: string;
	status: AgentJobStatus;
	durationMs: number;
}

export type LlmRequestStatus = 'ok' | 'unreachable' | 'refused' | 'unavailable';

export interface LlmRequestSample {
	// The model as the server names it, such as `claude` or `glm`.
	model: string;
	// What it was asked for: a turn of the built-in agent, or JSON for a widget.
	purpose: string;
	status: LlmRequestStatus;
	durationMs: number;
	inputTokens?: number;
	outputTokens?: number;
}

export interface AgentMetrics {
	recordJob(sample: AgentJobSample): void;
	recordLlmRequest(sample: LlmRequestSample): void;
}

// Jobs and model calls take seconds to minutes, not milliseconds.
const LONG_BUCKETS_MS: readonly number[] = [
	100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 600000,
];

/**
 * The built-in agent's work: its jobs by kind and how they ended, and every request of a model
 * with how long it took and the tokens it cost, on counters so any window can be summed.
 */
export function createAgentMetrics(client: MetricsClient): AgentMetrics {
	const jobs: Counter = client.counter('agent_jobs_total', {
		description: 'Built-in agent jobs run, by kind and how they ended',
	});
	const jobDuration: Histogram = client.histogram('agent_job_duration', {
		description: 'How long a built-in agent job ran',
		unit: 'ms',
		buckets: LONG_BUCKETS_MS,
	});
	const requests: Counter = client.counter('llm_requests_total', {
		description: 'Requests of a model, by model, purpose and how they ended',
	});
	const requestDuration: Histogram = client.histogram('llm_request_duration', {
		description: 'How long a model took to answer',
		unit: 'ms',
		buckets: LONG_BUCKETS_MS,
	});
	const tokens: Counter = client.counter('llm_tokens_total', {
		description: 'Tokens a model read (input) and wrote (output)',
	});

	return {
		recordJob({kind, status, durationMs}) {
			jobs.inc({kind, status});
			jobDuration.observe(durationMs, {kind, status});
		},
		recordLlmRequest({model, purpose, status, durationMs, inputTokens, outputTokens}) {
			requests.inc({model, purpose, status});
			requestDuration.observe(durationMs, {model, purpose});
			if (inputTokens && inputTokens > 0) {
				tokens.inc({model, kind: 'input'}, inputTokens);
			}
			if (outputTokens && outputTokens > 0) {
				tokens.inc({model, kind: 'output'}, outputTokens);
			}
		},
	};
}
