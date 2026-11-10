import {Err, Ok, Result} from 'ts-results-es';

export type ApiError =
	// `message`, where there is one, says what to do next, as for a web page nothing was found at.
	| {kind: 'not_found'; statusCode: 404; resource: string; id?: string; message?: string}
	// `message`, where there is one, says how to sign in again, as for a sandbox command's expired token.
	| {kind: 'unauthenticated'; statusCode: 401; message?: string}
	| {kind: 'forbidden'; statusCode: 403}
	| {kind: 'conflict'; statusCode: 409; message: string}
	| {kind: 'internal_error'; statusCode: 500; cause: unknown}
	| {kind: 'db_error'; statusCode: 500; cause: unknown}
	| {kind: 'parse_error'; statusCode: 400; message: string}
	| {kind: 'validation_error'; statusCode: 400; message: string}
	| {kind: 'mail_error'; statusCode: 500; message: string; cause: unknown}
	// A provider turned the credential down, such as a wrong app password.
	| {kind: 'credentials_rejected'; statusCode: 422}
	// A provider couldn't be reached or answered with something other than a verdict, or couldn't
	// reach what it was asked for; `message`, where there is one, the provider's own words for why,
	// or what to do next, passed on to agents in place of trying again.
	| {kind: 'provider_unreachable'; statusCode: 502; cause: unknown; message?: string}
	// Something this server needs for the request isn't set up, such as a key or a model.
	| {kind: 'unavailable'; statusCode: 503; message: string};

export const ApiErr = {
	notFound: (resource: string, id?: string, message?: string): ApiError => ({
		kind: 'not_found',
		statusCode: 404,
		resource,
		id,
		message,
	}),
	unauthenticated: (message?: string): ApiError =>
		message === undefined
			? {kind: 'unauthenticated', statusCode: 401}
			: {kind: 'unauthenticated', statusCode: 401, message},
	forbidden: (): ApiError => ({kind: 'forbidden', statusCode: 403}),
	conflict: (message: string): ApiError => ({kind: 'conflict', statusCode: 409, message}),
	internalError: (cause: unknown): ApiError => ({kind: 'internal_error', statusCode: 500, cause}),
	dbError: (cause: unknown): ApiError => ({kind: 'db_error', statusCode: 500, cause}),
	parseError: (message: string): ApiError => ({kind: 'parse_error', statusCode: 400, message}),
	validationError: (message: string): ApiError => ({
		kind: 'validation_error',
		statusCode: 400,
		message,
	}),
	mailError: (message: string, cause: unknown): ApiError => ({
		kind: 'mail_error',
		statusCode: 500,
		message,
		cause,
	}),
	credentialsRejected: (): ApiError => ({kind: 'credentials_rejected', statusCode: 422}),
	providerUnreachable: (cause: unknown, message?: string): ApiError => ({
		kind: 'provider_unreachable',
		statusCode: 502,
		cause,
		message,
	}),
	unavailable: (message: string): ApiError => ({kind: 'unavailable', statusCode: 503, message}),
};

function isApiError(error: unknown): error is ApiError {
	if (typeof error !== 'object' || error === null) {
		return false;
	}

	return 'kind' in error && 'statusCode' in error;
}

// Where `wrapDb` reports failed queries, and where it records every query. Server packages set
// them once at boot, so this package needs no logger or metrics of its own.
export interface DbLogger {
	warn(msg: string, ctx?: Record<string, unknown>): void;
}

export interface DbMetrics {
	recordQuery(query: {success: boolean; durationMs: number; errorKind?: string}): void;
}

let dbLogger: DbLogger | undefined;
let dbMetrics: DbMetrics | undefined;

export function setDbLogger(logger: DbLogger | undefined): void {
	dbLogger = logger;
}

export function setDbMetrics(metrics: DbMetrics | undefined): void {
	dbMetrics = metrics;
}

// Runs a query and turns a throw into a `db_error`, or passes an `ApiError` thrown inside through.
export async function wrapDb<T>(op: () => Promise<T>): Promise<Result<T, ApiError>> {
	const start = performance.now();
	const result = await Result.wrapAsync(op);
	const durationMs = Math.round(performance.now() - start);
	if (result.isOk()) {
		dbMetrics?.recordQuery({success: true, durationMs});
		return Ok(result.value);
	}

	const apiError = isApiError(result.error) ? result.error : ApiErr.dbError(result.error);
	dbMetrics?.recordQuery({success: false, durationMs, errorKind: apiError.kind});
	// A failure keeps a log line too, with its request's context beside the count.
	dbLogger?.warn('db query failed', {durationMs, errorKind: apiError.kind});
	return Err(apiError);
}
