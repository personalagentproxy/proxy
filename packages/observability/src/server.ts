import {formatFetchError} from '@proxy/utils';

import {type LokiConfig, type LokiStream, pushLoki} from './loki-client';
import {expandErrors} from './serialize-error';
import type {EnvLabel, LogEntry, LogLevel, ServiceLabel} from './types';

/**
 * The server's logger. Every line goes to stdout, as text in development and as one JSON object
 * per line in production, so a self-hosted server's `docker compose logs` has everything; with
 * Loki configured, lines are also buffered and pushed to it in batches, labelled by service, env
 * and level, with the context and the message as the JSON line. Without a Loki address the logger
 * writes stdout alone, so a server boots without credentials.
 */

export interface ServerLoggerConfig {
	loki: LokiConfig;
	service: ServiceLabel;
	env: EnvLabel;
	// How lines are written to stdout: readable text, one JSON object per line, or not at all. By
	// default text in development and JSON in production.
	stdout?: 'pretty' | 'json' | 'off';
	maxBufferSize?: number;
	flushIntervalMs?: number;
	// Lines below it are dropped. By default debug in development and info in production.
	minLevel?: LogLevel;
	// Context every line gets, read as the line is written: the request it is in, say.
	getAmbientContext?: () => Record<string, unknown> | undefined;
}

export interface Logger {
	debug(msg: string, ctx?: Record<string, unknown>): void;
	info(msg: string, ctx?: Record<string, unknown>): void;
	warn(msg: string, ctx?: Record<string, unknown>): void;
	error(msg: string, ctx?: Record<string, unknown>): void;
	/** A logger whose every line has `ctx` too. */
	child(ctx: Record<string, unknown>): Logger;
	/** Pushes what is buffered to Loki now. */
	flush(): Promise<void>;
	/** Stops the flush timer and pushes what is left; lines after it go to stdout alone. */
	shutdown(): Promise<void>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

const NS_PER_MS = BigInt(1_000_000);

function msToNs(ms: number): string {
	return (BigInt(ms) * NS_PER_MS).toString();
}

function hasKeys(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
	return value !== undefined && Object.keys(value).length > 0;
}

// The Loki line: the context, then the message, so a `msg` key in the context (a forwarded
// client line's, say) can't overwrite the message.
function entryToLine(entry: LogEntry): string {
	if (!hasKeys(entry.ctx)) {
		return JSON.stringify({msg: entry.msg});
	}
	return JSON.stringify({...entry.ctx, msg: entry.msg});
}

function groupByLevel(entries: LogEntry[], baseLabels: Record<string, string>): LokiStream[] {
	const byLevel = new Map<LogLevel, Array<[string, string]>>();
	for (const entry of entries) {
		const list = byLevel.get(entry.level) ?? [];
		list.push([msToNs(entry.ts), entryToLine(entry)]);
		byLevel.set(entry.level, list);
	}

	const streams: LokiStream[] = [];
	for (const [level, values] of byLevel) {
		streams.push({stream: {...baseLabels, level}, values});
	}
	return streams;
}

function write(level: LogLevel, ...args: unknown[]): void {
	if (level === 'error') {
		console.error(...args);
		return;
	}
	if (level === 'warn') {
		console.warn(...args);
		return;
	}
	console.log(...args);
}

function writePretty(entry: LogEntry, service: string): void {
	const prefix = `[${service}] ${entry.level.toUpperCase()}`;
	if (!hasKeys(entry.ctx)) {
		write(entry.level, prefix, entry.msg);
		return;
	}
	write(entry.level, prefix, entry.msg, entry.ctx);
}

// The fixed fields first, then the context, and the fixed fields again where the context named
// one of them, so a line always says when, what level, who and what.
function writeJson(entry: LogEntry, service: string): void {
	const fixed = {ts: new Date(entry.ts).toISOString(), level: entry.level, service, msg: entry.msg};
	write(entry.level, JSON.stringify(Object.assign({...fixed}, entry.ctx ?? {}, fixed)));
}

export function createServerLogger(config: ServerLoggerConfig): Logger {
	const baseLabels: Record<string, string> = {service: config.service, env: config.env};
	const stdout = config.stdout ?? (config.env === 'development' ? 'pretty' : 'json');
	const minLevel = config.minLevel ?? (config.env === 'development' ? 'debug' : 'info');
	const maxBufferSize = config.maxBufferSize ?? 50;
	const flushIntervalMs = config.flushIntervalMs ?? 5_000;
	// A long Loki outage can't grow the buffer without bound.
	const maxRetainedOnFailure = maxBufferSize * 20;
	const lokiDisabled = config.loki.url.length === 0;

	let buffer: LogEntry[] = [];
	let isShutDown = false;
	// Flushes follow each other through this promise, so a slow push can't be overtaken by a later
	// one, which would put retried lines after fresher ones.
	let flushChain: Promise<void> = Promise.resolve();

	async function doFlush(): Promise<void> {
		if (buffer.length === 0) {
			return;
		}

		const snapshot = buffer;
		buffer = [];

		if (lokiDisabled) {
			return;
		}

		const result = await pushLoki(config.loki, {streams: groupByLevel(snapshot, baseLabels)});
		if (result.isOk()) {
			return;
		}
		console.error('[observability] Loki push failed:', formatFetchError(result.error));
		// Back into the buffer for the next flush. Over the cap, the oldest lines go first: the
		// first error of an outage is sometimes the most telling, but old context is a better
		// loss than unbounded memory.
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

		if (stdout === 'pretty') {
			writePretty(entry, config.service);
		}
		if (stdout === 'json') {
			writeJson(entry, config.service);
		}

		// After shutdown the flush timer is gone; stdout has the line, Loki doesn't.
		if (isShutDown || lokiDisabled) {
			return;
		}

		buffer.push(entry);
		if (buffer.length >= maxBufferSize) {
			void flush();
		}
	}

	const interval = lokiDisabled ? undefined : setInterval(() => void flush(), flushIntervalMs);
	interval?.unref();

	async function shutdown(): Promise<void> {
		if (isShutDown) {
			return;
		}
		isShutDown = true;
		clearInterval(interval);
		await flush();
	}

	// For a process that doesn't call shutdown itself, such as a short script: the runtime waits
	// for the promise, so the last batch is pushed.
	if (!lokiDisabled && typeof process !== 'undefined' && typeof process.once === 'function') {
		process.once('beforeExit', () => void shutdown());
	}

	function build(parentCtx: Record<string, unknown>): Logger {
		function merged(ctx: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
			const ambient = config.getAmbientContext?.();
			if (!hasKeys(ctx) && !hasKeys(ambient) && !hasKeys(parentCtx)) {
				return undefined;
			}
			// Errors anywhere in the context are expanded here, since `JSON.stringify` would make
			// them `{}` (serialize-error.ts).
			return expandErrors({...ambient, ...parentCtx, ...ctx}) as Record<string, unknown>;
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
