import type {FetchError} from '@proxy/utils';
import {apiMessage} from '@/lib/agent-errors';

// Where a widget's write is: not yet, on its way, done (with where to see it), or refused.
export type WriteStatus =
	| {kind: 'idle'}
	| {kind: 'saving'}
	| {kind: 'done'; message: string; link: string | null}
	| {kind: 'failed'; message: string};

/** What a widget says when the api refused its write: the api's own reason where it gave one. */
export function writeErrorMessage(error: FetchError): string {
	if (error.kind === 'http') {
		return apiMessage(error.body) ?? 'That didn’t work. Try again.';
	}
	return 'The server could not be reached. Try again.';
}
