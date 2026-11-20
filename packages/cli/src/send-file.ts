import {Err, Ok, Result} from 'ts-results-es';

import {type Failure, failed, type Io, isObject, type Json} from './io';

/**
 * A file's bytes sent to the URL an upload was answered with (`pap files push`, files.ts), in one
 * PUT, read from disk as they go, never whole. The URL is Personal Agent Proxy's own, for every
 * drive, and its own credential, so PAP_TOKEN is never sent to it.
 */

/** Where the bytes go and how, as the upload was answered with it. */
export type Put = {url: string; headers: Record<string, string>};

function errorText(cause: Error | string | null): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// The words a refusal came with: PAP's `message`.
async function refusalOf(response: Response): Promise<string> {
	const text = (await Result.wrapAsync<string, Error>(() => response.text())).unwrapOr('');
	const body = Result.wrap((): Json => JSON.parse(text)).unwrapOr(null);
	if (isObject(body) && typeof body.message === 'string') {
		return body.message;
	}
	return `The upload’s URL answered ${response.status}.`;
}

/** Sends the file at `path`, `size` bytes, to where the upload said, streamed from disk with its length said first. */
export async function sendFile(
	io: Io,
	path: string,
	size: number,
	to: Put,
): Promise<Result<void, Failure>> {
	const init: RequestInit & {duplex: 'half'} = {
		method: 'PUT',
		headers: {...to.headers, 'content-length': String(size)},
		body: io.readStream(path),
		duplex: 'half',
	};
	const sent = await Result.wrapAsync<Response, Error>(() => io.fetch(to.url, init));
	if (sent.isErr()) {
		return Err(failed(`Could not send ${path}: ${errorText(sent.error)}. Push it again.`));
	}
	if (!sent.value.ok) {
		return Err(failed(await refusalOf(sent.value)));
	}
	await sent.value.body?.cancel();
	return Ok(undefined);
}
