import {Result} from 'ts-results-es';

import type {ClientLogBatch, EnvLabel, LogEntry, LogLevel} from './types';

export {serializeError} from './serialize-error';

/**
 * The web app's logger. Lines are written to the console in development and posted to the api in
 * batches, with the session's cookies, which forwards them to Loki as the web app's or the
 * desktop app's (the api's client-logs.ts). What is left when the page is hidden goes by
 * `sendBeacon`, which outlives it. A batch the api refuses (4xx) is dropped, since the same bytes
 * would be refused again; one it can't take (5xx, no network) is kept for the next flush.
 */

export interface ClientLoggerConfig {
	// Where the api takes batches, such as `/api/client-logs`; empty, nothing is posted.
	endpoint: string;
	env: EnvLabel;
	echoToConsole?: boolean;
	maxBatchSize?: number;
	flushIntervalMs?: number;
	minLevel?: LogLevel;
}

export interface ClientLogger {
	debug(msg: string, ctx?: Record<string, unknown>): void;
	info(msg: string, ctx?: Record<string, unknown>): void;
	warn(msg: string, ctx?: Record<string, unknown>): void;
	error(msg: string, ctx?: Record<string, unknown>): void;
	child(ctx: Record<string, unknown>): ClientLogger;
	flush(): Promise<void>;
	/** Sends what is left by `sendBeacon`, which returns before the network does, and stops. */
	shutdown(): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

type ShipOutcome = 'ok' | 'retry' | 'drop';

function echoEntry(entry: LogEntry): void {
	const prefix = `[client] ${entry.level.toUpperCase()}`;
	if (entry.level === 'error') {
		console.error(prefix, entry.msg, entry.ctx ?? {});
		return;
	}
	if (entry.level === 'warn') {
		console.warn(prefix, entry.msg, entry.ctx ?? {});
		return;
	}
	console.log(prefix, entry.msg, entry.ctx ?? {});
}

export function createClientLogger(config: ClientLoggerConfig): ClientLogger {
	const echo = config.echoToConsole ?? config.env === 'development';
	const minLevel = config.minLevel ?? 'debug';
	const maxBatchSize = config.maxBatchSize ?? 20;
	const flushIntervalMs = config.flushIntervalMs ?? 5_000;
	const endpoint = config.endpoint;
	const transportDisabled = endpoint.length === 0;
	const maxRetainedOnFailure = maxBatchSize * 20;

	let buffer: LogEntry[] = [];
	let interval: ReturnType<typeof setInterval> | undefined;
	let isShutDown = false;
	let flushChain: Promise<void> = Promise.resolve();

	async function ship(entries: LogEntry[]): Promise<ShipOutcome> {
		const payload: ClientLogBatch = {entries};
		const result = await Result.wrapAsync(() =>
			fetch(endpoint, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(payload),
				credentials: 'include',
				keepalive: true,
			}),
		);
		if (result.isErr()) {
			return 'retry';
		}
		if (result.value.ok) {
			return 'ok';
		}
		if (result.value.status >= 400 && result.value.status < 500) {
			return 'drop';
		}
		return 'retry';
	}

	function shipBeacon(entries: LogEntry[]): void {
		if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
			void ship(entries);
			return;
		}
		const payload: ClientLogBatch = {entries};
		const blob = new Blob([JSON.stringify(payload)], {type: 'application/json'});
		if (!navigator.sendBeacon(endpoint, blob)) {
			void ship(entries);
		}
	}

	async function doFlush(): Promise<void> {
		if (buffer.length === 0) {
			return;
		}
		const snapshot = buffer;
		buffer = [];
		if (transportDisabled) {
			return;
		}
		const outcome = await ship(snapshot);
		if (outcome !== 'retry') {
			return;
		}
		const merged = snapshot.concat(buffer);
		buffer =
			merged.length > maxRetainedOnFailure
				? merged.slice(merged.length - maxRetainedOnFailure)
				: merged;
	}

	function flush(): Promise<void> {
		flushChain = flushChain.then(doFlush, doFlush);
		return flushChain;
	}

	function enqueue(level: LogLevel, msg: string, ctx: Record<string, unknown> | undefined): void {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
			return;
		}
		const entry: LogEntry = {ts: Date.now(), level, msg, ctx};
		if (echo) {
			echoEntry(entry);
		}
		if (isShutDown || transportDisabled) {
			return;
		}
		buffer.push(entry);
		if (buffer.length >= maxBatchSize) {
			void flush();
		}
	}

	function shutdown(): void {
		if (isShutDown) {
			return;
		}
		isShutDown = true;
		clearInterval(interval);
		if (buffer.length === 0 || transportDisabled) {
			return;
		}
		const snapshot = buffer;
		buffer = [];
		shipBeacon(snapshot);
	}

	if (!transportDisabled && typeof window !== 'undefined') {
		interval = setInterval(() => void flush(), flushIntervalMs);
		window.addEventListener('pagehide', shutdown);
	}

	function build(parentCtx: Record<string, unknown>): ClientLogger {
		function merged(ctx: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
			if (!ctx && Object.keys(parentCtx).length === 0) {
				return undefined;
			}
			return {...parentCtx, ...ctx};
		}
		return {
			debug: (msg, ctx) => enqueue('debug', msg, merged(ctx)),
			info: (msg, ctx) => enqueue('info', msg, merged(ctx)),
			warn: (msg, ctx) => enqueue('warn', msg, merged(ctx)),
			error: (msg, ctx) => enqueue('error', msg, merged(ctx)),
			child: (ctx) => build({...parentCtx, ...ctx}),
			flush,
			shutdown,
		};
	}

	return build({});
}
