import {Err, Ok, Result} from 'ts-results-es';

export type ApiError =
	| {kind: 'not_found'; statusCode: 404; resource: string; id?: string}
	| {kind: 'unauthenticated'; statusCode: 401}
	| {kind: 'forbidden'; statusCode: 403}
	| {kind: 'conflict'; statusCode: 409; message: string}
	| {kind: 'internal_error'; statusCode: 500; cause: unknown}
	| {kind: 'db_error'; statusCode: 500; cause: unknown}
	| {kind: 'parse_error'; statusCode: 400; message: string}
	| {kind: 'validation_error'; statusCode: 400; message: string}
	| {kind: 'mail_error'; statusCode: 500; message: string; cause: unknown}
	// A provider turned the credential down, such as a wrong app password.
	| {kind: 'credentials_rejected'; statusCode: 422}
	// A provider couldn't be reached or answered with something other than a verdict.
	| {kind: 'provider_unreachable'; statusCode: 502; cause: unknown};

export const ApiErr = {
	notFound: (resource: string, id?: string): ApiError => ({
		kind: 'not_found',
		statusCode: 404,
		resource,
		id,
	}),
	unauthenticated: (): ApiError => ({kind: 'unauthenticated', statusCode: 401}),
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
	providerUnreachable: (cause: unknown): ApiError => ({
		kind: 'provider_unreachable',
		statusCode: 502,
		cause,
	}),
};

function isApiError(error: unknown): error is ApiError {
	if (typeof error !== 'object' || error === null) {
		return false;
	}

	return 'kind' in error && 'statusCode' in error;
}

// Where `wrapDb` reports failed queries. Server packages set it once at boot, so this package
// needs no logger of its own.
export interface DbLogger {
	warn(msg: string, ctx?: Record<string, unknown>): void;
}

let dbLogger: DbLogger | undefined;

export function setDbLogger(logger: DbLogger | undefined): void {
	dbLogger = logger;
}

// Runs a query and turns a throw into a `db_error`, or passes an `ApiError` thrown inside through.
export async function wrapDb<T>(op: () => Promise<T>): Promise<Result<T, ApiError>> {
	const start = performance.now();
	const result = await Result.wrapAsync(op);
	if (result.isOk()) {
		return Ok(result.value);
	}

	const apiError = isApiError(result.error) ? result.error : ApiErr.dbError(result.error);
	dbLogger?.warn('db query failed', {
		durationMs: Math.round(performance.now() - start),
		errorKind: apiError.kind,
	});
	return Err(apiError);
}
