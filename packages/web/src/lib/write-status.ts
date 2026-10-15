import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {apiMessage} from '@/lib/agent-errors';

// Where a widget's write is: not yet, on its way, done (with where to see it), or refused.
export type WriteStatus =
	| {kind: 'idle'}
	| {kind: 'saving'}
	| {kind: 'done'; message: string; link: string | null}
	| {kind: 'failed'; message: string};

const IDLE: WriteStatus = {kind: 'idle'};

/**
 * A widget's write, for what is typed now: once the text changes the widget is about something
 * else, and a write that finishes after that is for text that's gone.
 */
export function useWriteStatus(typed: string): [WriteStatus, (status: WriteStatus) => void] {
	const [state, setState] = useState<{typed: string; status: WriteStatus}>({typed, status: IDLE});
	return [state.typed === typed ? state.status : IDLE, (status) => setState({typed, status})];
}

/** What a widget says when the api refused its write: the api's own reason where it gave one. */
export function writeErrorMessage(error: FetchError): string {
	if (error.kind === 'http') {
		return apiMessage(error.body) ?? 'That didn’t work. Try again.';
	}
	return 'The server could not be reached. Try again.';
}
