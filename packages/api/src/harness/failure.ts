import type {ApiError} from '@proxy/utils';

/** A failure in words, for a job's or a poll's record and whoever is told of it. */
export function describeFailure(failure: ApiError): string {
	if ('message' in failure && failure.message) {
		return failure.message;
	}
	if (failure.kind === 'not_found') {
		return `There is no ${failure.resource}${failure.id ? ` ${failure.id}` : ''}`;
	}
	if ('cause' in failure) {
		return failure.cause instanceof Error ? failure.cause.message : `${failure.kind}: ${JSON.stringify(failure.cause)}`;
	}
	return failure.kind;
}
