import {z} from 'zod';

/**
 * What every log line and metric carries, shared by the api, which writes and forwards them, and
 * the web app, which sends its own to the api (client.ts).
 */

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const logEntrySchema = z.object({
	// Milliseconds since the epoch.
	ts: z.number().int().positive(),
	level: logLevelSchema,
	msg: z.string().min(1).max(8_000),
	ctx: z.record(z.string(), z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** A batch of the web app's log lines, as it posts them to the api. */
export const clientLogBatchSchema = z.object({
	entries: z.array(logEntrySchema).min(1).max(100),
});
export type ClientLogBatch = z.infer<typeof clientLogBatchSchema>;

// Metric names follow Prometheus naming. Labels are key/value strings; the api's registry decides
// which names and labels it takes from the web app, so a browser can't inflate cardinality.
const metricNameRegex = /^[a-z_][a-z0-9_]*$/;

export const clientMetricEntrySchema = z.object({
	ts: z.number().int().positive(),
	name: z.string().min(1).max(120).regex(metricNameRegex),
	value: z.number().finite(),
	labels: z.record(z.string().regex(metricNameRegex), z.string().min(1).max(64)).optional(),
});
export type ClientMetricEntry = z.infer<typeof clientMetricEntrySchema>;

export const clientMetricBatchSchema = z.object({
	entries: z.array(clientMetricEntrySchema).min(1).max(100),
});
export type ClientMetricBatch = z.infer<typeof clientMetricBatchSchema>;

/**
 * Who wrote a line: the api; the web app in a browser, or in the desktop app's window, which the
 * api tells apart by the user agent the desktop app sets; and, beside hosted Personal Agent
 * Proxy, the internal service and the admin, which take this package as a workspace.
 */
export const serviceLabels = ['api', 'web', 'desktop', 'internal', 'admin'] as const;
export type ServiceLabel = (typeof serviceLabels)[number];

export const envLabels = ['development', 'production'] as const;
export type EnvLabel = (typeof envLabels)[number];
