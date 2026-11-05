import {hostname} from 'node:os';

import {setDbMetrics} from '@proxy/utils';
import {type AgentMetrics, createAgentMetrics, createDbMetricsRecorder, createMetricsClient, createToolMetrics, type MetricsClient, type ToolMetrics} from '@proxy/observability';

import {envLabel, metricsConfig} from './config';

/**
 * The api's metrics, pushed over OTLP when METRICS_OTLP_URL is set (config.ts) and
 * summed up for nothing otherwise. Each instance pushes as itself: Render names it, and a machine
 * elsewhere is its host and process.
 */
export const metrics: MetricsClient = createMetricsClient({
	...metricsConfig,
	service: 'api',
	env: envLabel,
	instanceId: process.env.RENDER_INSTANCE_ID || `${hostname()}-${process.pid}`,
});

setDbMetrics(createDbMetricsRecorder(metrics));

/** Every request of an agent, recorded beside its entry in the activity log. */
export const toolMetrics: ToolMetrics = createToolMetrics(metrics);

/** The built-in agent's jobs, and every request of a model. */
export const agentMetrics: AgentMetrics = createAgentMetrics(metrics);
