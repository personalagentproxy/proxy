import {setDbLogger} from '@proxy/utils';

type LogContext = Record<string, unknown>;

export type Logger = {
	debug(msg: string, ctx?: LogContext): void;
	info(msg: string, ctx?: LogContext): void;
	warn(msg: string, ctx?: LogContext): void;
	error(msg: string, ctx?: LogContext): void;
};

function write(level: keyof Logger, msg: string, ctx?: LogContext): void {
	const line = `[api] ${level} ${msg}`;
	if (ctx === undefined) {
		console[level](line);
		return;
	}

	console[level](line, ctx);
}

export const log: Logger = {
	debug: (msg, ctx) => write('debug', msg, ctx),
	info: (msg, ctx) => write('info', msg, ctx),
	warn: (msg, ctx) => write('warn', msg, ctx),
	error: (msg, ctx) => write('error', msg, ctx),
};

setDbLogger(log);

/** Flattens anything thrown or returned as an error into a log context. */
export function serializeError(error: unknown): LogContext {
	if (error instanceof Error) {
		return {errorName: error.name, errorMessage: error.message, stack: error.stack};
	}

	if (typeof error === 'object' && error !== null) {
		return {error: {...error}};
	}

	return {error: String(error)};
}
