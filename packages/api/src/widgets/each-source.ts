import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import type {Source} from './sources';

/** A source that couldn't be read, and why, in a line the widget shows. */
export type Failure = {connectionId: string; account: string; message: string};

type Gathered<S, T> = {found: Array<{source: S; value: T}>; failed: Failure[]};

// How long a widget waits for one source: one that is slow is left out rather than holding up the rest.
const TIMEOUT_MS = 6_000;

function timeout(): Promise<Result<never, ApiError>> {
	return new Promise((resolve) => setTimeout(() => resolve(Err(ApiErr.providerUnreachable(new Error('Timed out')))), TIMEOUT_MS));
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
 * expired sign-in doesn't empty a widget.
 */
export async function eachSource<S extends Source, T>(sources: S[], work: (source: S) => Promise<Result<T, ApiError>>): Promise<Gathered<S, T>> {
	const results = await Promise.all(sources.map((source) => Promise.race([work(source), timeout()])));
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
