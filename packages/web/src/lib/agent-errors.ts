import type {FetchError} from '@proxy/utils';
import {isTaskRefusal} from '@/lib/agent-task';

// What a failed change tells the agent, in words a model reading the page can act on.
// The api's own words for a refusal, when it has them: a value a column doesn't take, a statement
// that isn't one that reads.
export function apiMessage(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || !('message' in body)) {
		return null;
	}
	return typeof body.message === 'string' && body.message !== '' ? body.message : null;
}

export function agentErrorMessage(error: FetchError): string {
	if (isTaskRefusal(error)) {
		return 'This task can’t be worked on anymore: it, or the task it is part of, is finished, or it isn’t this login’s. Switch task, or start a new one.';
	}
	if (error.kind === 'http' && error.status === 403) {
		return 'This login is not allowed to do that.';
	}
	if (error.kind === 'http' && error.status === 400) {
		return (
			apiMessage(error.body) ??
			'Some of the values are not accepted, or one is missing, such as a draft’s recipient. Check the fields and try again.'
		);
	}
	if (error.kind === 'http' && error.status === 404) {
		return 'It is not there anymore, or the mailbox has no folder for it.';
	}
	if (error.kind === 'http' && error.status === 422) {
		return 'The provider turned the sign-in down. Ask the person who made this login to reconnect it.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The provider could not be reached. Try again in a moment.';
	}
	if (error.kind === 'http' && error.status === 401) {
		return 'This login has been signed out. Sign in again.';
	}
	return 'Something went wrong. Try again.';
}
