import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {Failure} from '@proxy/contracts/widgets';

import {log, serializeError} from '../observability/log';
import type {Source} from './sources';

type Gathered<S, T> = {found: Array<{source: S; value: T}>; failed: Failure[]};

// How long a widget waits for one source: one that is slow is left out rather than holding up the rest.
const TIMEOUT_MS = 6_000;

/** Work on one source, told by `signal` when it is given up on, as an IMAP sign-in is then closed. */
export type SourceWork<S, T> = (source: S, signal: AbortSignal) => Promise<Result<T, ApiError>>;

// What `work` answers for a source, or a failure once it has taken too long, when it is told to stop.
async function withinTimeout<S, T>(source: S, work: SourceWork<S, T>): Promise<Result<T, ApiError>> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<Result<never, ApiError>>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(Err(ApiErr.providerUnreachable(new Error('Timed out'))));
		}, TIMEOUT_MS);
	});
	const result = await Promise.race([work(source, controller.signal), timedOut]);
	clearTimeout(timer);
	return result;
}

/** What a widget says of a source it couldn't read. */
function failureMessage(error: ApiError): string {
	if (error.kind === 'credentials_rejected') {
		return 'its sign-in has run out: connect it again';
	}
	if (error.kind === 'provider_unreachable') {
		return 'it could not be reached';
	}
	if (error.kind === 'validation_error' || error.kind === 'conflict' || error.kind === 'unavailable' || error.kind === 'mail_error') {
		return error.message;
	}
	return 'something went wrong';
}

/**
 * Runs `work` on every source at once and gathers what each found. A source that fails, or takes
 * longer than six seconds, is a failure beside the rest rather than failing them all, so one
 * expired sign-in doesn't empty a widget; one given up on is told to stop.
 */
export async function eachSource<S extends Source, T>(sources: S[], work: SourceWork<S, T>): Promise<Gathered<S, T>> {
	const results = await Promise.all(sources.map((source) => withinTimeout(source, work)));
	const gathered: Gathered<S, T> = {found: [], failed: []};
	results.forEach((result, index) => {
		const source = sources[index];
		if (!source) {
			return;
		}
		if (result.isOk()) {
			gathered.found.push({source, value: result.value});
			return;
		}
		const {id, integrationId, account} = source.connection;
		log.warn('A widget could not read a source', {connectionId: id, integrationId, kind: result.error.kind, ...('cause' in result.error ? serializeError(result.error.cause) : {})});
		gathered.failed.push({connectionId: id, account, message: failureMessage(result.error)});
	});
	return gathered;
}
