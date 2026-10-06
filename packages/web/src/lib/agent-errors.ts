import type {FetchError} from '@proxy/utils';

// What a failed change tells the agent, in words a model reading the page can act on.
export function agentErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 403) {
		return 'This login is not allowed to do that.';
	}
	if (error.kind === 'http' && error.status === 400) {
		return 'Some of the values are not accepted. Check the fields and try again.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The provider could not be reached. Try again in a moment.';
	}
	if (error.kind === 'http' && error.status === 401) {
		return 'This login has been signed out. Sign in again.';
	}
	return 'Something went wrong. Try again.';
}
