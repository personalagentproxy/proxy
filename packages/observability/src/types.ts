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

/**
 * Who wrote a line: the api; the web app in a browser, or in the desktop app's window, which the
 * api tells apart by the user agent the desktop app sets; and, beside hosted Personal Agent
 * Proxy, the internal service and the admin, which take this package as a workspace.
 */
export const serviceLabels = ['api', 'web', 'desktop', 'internal', 'admin'] as const;
export type ServiceLabel = (typeof serviceLabels)[number];

export const envLabels = ['development', 'production'] as const;
export type EnvLabel = (typeof envLabels)[number];
