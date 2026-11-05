import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * What every log line written while handling a request, or running a built-in agent's job, says
 * about it, without each call site passing it along: the request logger opens a scope for the
 * request (server/middleware/request-logger.ts), the auth wrappers add who it is from, and the
 * harness worker opens one for each job it runs. The logger reads the scope as it writes
 * (log.ts).
 */
export type LogContext = {
	requestId?: string;
	method?: string;
	path?: string;
	userId?: string;
	orgId?: string;
	agentId?: string;
	jobId?: string;
	jobKind?: string;
	threadId?: string;
	workerId?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `ctx` as the scope of everything it does, however async. */
export function runInContext<T>(ctx: LogContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

/** The scope of the current request or job; none outside either. */
export function getContext(): LogContext | undefined {
	return storage.getStore();
}

/** Adds to the current scope, as the auth wrappers add who a request is from; nothing outside one. */
export function addContext(values: Partial<LogContext>): void {
	const store = storage.getStore();
	if (!store) {
		return;
	}
	Object.assign(store, values);
}
