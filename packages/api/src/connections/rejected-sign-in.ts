import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {markCredentialRejected} from '@proxy/db/connection';

import {log} from '../observability/log';

/**
 * Notes on the connection that its provider turned `credential` down, where `answer` says so, so
 * it shows as needing signing in to again and nothing more is asked of the provider until it is.
 * The answer is passed on as it was; a note that couldn't be made is logged.
 */
export async function noteRejectedSignIn<T>(connection: {id: string}, credential: string | null, answer: Result<T, ApiError>): Promise<Result<T, ApiError>> {
	if (answer.isOk() || answer.error.kind !== 'credentials_rejected' || credential === null) {
		return answer;
	}
	const marked = await markCredentialRejected({connectionId: connection.id, credential});
	if (marked.isErr()) {
		log.warn('A connection’s turned-down sign-in could not be noted', {connectionId: connection.id, errorKind: marked.error.kind});
	}
	return answer;
}
