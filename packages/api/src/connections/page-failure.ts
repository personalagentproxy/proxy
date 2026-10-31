import {ApiErr, type ApiError, type FetchError} from '@proxy/utils';

/**
 * Why a web page couldn't be read, from what Exa, Parallel or Keenable says in its own way, as an
 * error an agent can act on: the address it asked for, and whether to look for it elsewhere or
 * try again. Nothing at the address is not found; a site that was slow, busy or failing, out of
 * reach for now; a site that turned the crawler away, or a page with no text or that isn't text,
 * turned down, there being no point in trying again.
 */
export type PageFailure = {kind: 'missing' | 'timeout' | 'unsupported' | 'empty'} | {kind: 'refused' | 'busy'; status: number};

const ELSEWHERE = 'find the same content at another address with searches_run, or ask the person for it';

/** What a site's HTTP status says of a page, where it is a failure of a known kind. */
export function httpPageFailure(status: number): PageFailure | null {
	if (status === 404 || status === 410) {
		return {kind: 'missing'};
	}
	if (status === 401 || status === 403) {
		return {kind: 'refused', status};
	}
	if (status === 429 || (status >= 500 && status < 600)) {
		return {kind: 'busy', status};
	}
	return null;
}

// The site's status, as the activity log keeps it beside the error's kind: `provider_unreachable 503`.
function siteStatus(url: string, status: number): FetchError {
	return {kind: 'http', url, status, body: null};
}

/** The error for a page `provider` couldn't read at `url`. */
export function pageError(provider: string, url: string, failure: PageFailure): ApiError {
	if (failure.kind === 'missing') {
		return ApiErr.notFound(
			'page',
			url,
			`${provider} found no page at ${url}: it may have moved or been taken down, or ${provider}’s crawler may not reach it. Search for its current address with searches_run, or read the same content at another address, such as a file’s raw address instead of its page, or the other way round.`,
		);
	}
	if (failure.kind === 'timeout') {
		return ApiErr.providerUnreachable(
			new Error(`${provider} timed out reading the page`),
			`${provider} timed out reading ${url}: the site was too slow to answer. Try again in a few minutes, or ${ELSEWHERE}.`,
		);
	}
	if (failure.kind === 'busy' && failure.status === 429) {
		return ApiErr.providerUnreachable(siteStatus(url, failure.status), `${url} turned ${provider}’s crawler away for too many requests (HTTP 429). Try again in a few minutes.`);
	}
	if (failure.kind === 'busy') {
		return ApiErr.providerUnreachable(siteStatus(url, failure.status), `The site at ${url} failed to answer ${provider}’s crawler (HTTP ${failure.status}). Try again in a few minutes.`);
	}
	if (failure.kind === 'refused') {
		return ApiErr.validationError(`${url} turned ${provider}’s crawler away (HTTP ${failure.status}): the site needs a sign-in or blocks crawlers. Trying again won’t help: ${ELSEWHERE}.`);
	}
	if (failure.kind === 'unsupported') {
		return ApiErr.validationError(
			`${provider} can’t read ${url}: it answered with a type of content ${provider} doesn’t read as text, such as an image or another binary file. Trying again won’t help: look for a web page that shows the same content.`,
		);
	}
	return ApiErr.validationError(
		`${provider} found no text at ${url}: the page may be empty, or built by JavaScript as it loads, which the crawler doesn’t run. Trying again won’t help: ${ELSEWHERE}.`,
	);
}
