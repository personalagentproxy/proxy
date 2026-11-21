import {Err, Ok, Result} from 'ts-results-es';

import {Do} from '@proxy/utils/do';

import type {Parsed} from './args';
import type {Client} from './client';
import {clientFrom} from './client';
import {type Failure, failed, type Io, isObject, type Json, usage} from './io';

/**
 * `pap upload` and `pap download`: a file of the sandbox made a blob, and a blob brought into the
 * sandbox. A blob is a file passed between tools for a day, the agent's alone: a tool hands one
 * over, as `attachments_blob` an email's attachment, and another takes it, as `files_upload` puts
 * it in a drive. The bytes go to and come from URLs the `upload` and `download` functions answer
 * with, Personal Agent Proxy's own and their own credential, so PAP_TOKEN is never sent to them.
 * A file goes up in one PUT, read from disk as it goes, never whole, and its SHA-256, read first,
 * is checked against what arrived.
 */

export const UPLOAD = 'pap upload <file>';
export const DOWNLOAD = 'pap download <blob> [to]';

export const UPLOAD_HELP = `${UPLOAD}
Makes a blob of a file, for a tool that takes one, as files_upload puts it in a drive. Prints the
blob's id. A blob is kept for a day.
`;

export const DOWNLOAD_HELP = `${DOWNLOAD}
Brings a blob into the sandbox, as a tool made it, as attachments_blob of an email's attachment:
into the current directory under its own name, or to a path or into a directory. Under its own
name it never writes over a file that is there; a path given in full does.
`;

function errorText(cause: Error | string | null): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// A response's body as JSON, or nothing where it isn't.
async function jsonOf(response: Response): Promise<Json | undefined> {
	const text = (await Result.wrapAsync<string, Error>(() => response.text())).unwrapOr('');
	return Result.wrap((): Json => JSON.parse(text)).unwrapOr(undefined);
}

// What a blob's URL refused with: PAP's `message`.
async function refusalOf(response: Response): Promise<string> {
	const body = await jsonOf(response);
	if (isObject(body) && typeof body.message === 'string') {
		return body.message;
	}
	return `The blob’s URL answered ${response.status}.`;
}

// The URL a `pap` function answered with.
function urlOf(answer: Json): Result<string, Failure> {
	if (!isObject(answer) || typeof answer.url !== 'string') {
		return Err(failed('PAP answered without a URL. Try again.'));
	}
	return Ok(answer.url);
}

/** A file of the sandbox as read before it is sent: where it is, its name, its size and its SHA-256. */
export type LocalFile = {local: string; name: string; size: number; sha256: string};

/** Reads the file at `local` through, for its size and SHA-256. */
export async function readLocal(io: Io, local: string): Promise<Result<LocalFile, Failure>> {
	const read = await io.hashFile(local);
	return read
		.map((hashed) => ({local, name: local.split('/').at(-1) ?? '', ...hashed}))
		.mapErr((cause) => failed(`Could not read ${local}: ${cause.message}.`));
}

/** A blob made of a file: its id, its name, and what arrived. */
export type Uploaded = {blob: string; name: string; size: number; sha256: string};

/** Makes a blob of a file read with `readLocal`: sent in one PUT, streamed from disk with its length, and checked against its SHA-256. */
export function uploadFile(
	io: Io,
	client: Client,
	{local, name, size, sha256}: LocalFile,
): Promise<Result<Uploaded, Failure>> {
	return Do(async ($) => {
		const url = $(urlOf($(await client.call('upload', []))));
		const init: RequestInit & {duplex: 'half'} = {
			method: 'PUT',
			headers: {'content-length': String(size)},
			body: io.readStream(local),
			duplex: 'half',
		};
		const sent = await Result.wrapAsync<Response, Error>(() =>
			io.fetch(`${url}?name=${encodeURIComponent(name)}`, init),
		);
		if (sent.isErr()) {
			return $(Err(failed(`Could not send ${local}: ${errorText(sent.error)}. Send it again.`)));
		}
		if (!sent.value.ok) {
			return $(Err(failed(await refusalOf(sent.value))));
		}
		const answer = await jsonOf(sent.value);
		if (!isObject(answer) || typeof answer.blob !== 'string' || typeof answer.sha256 !== 'string') {
			return $(Err(failed('PAP answered without the blob it made. Send the file again.')));
		}
		if (answer.sha256 !== sha256) {
			return $(
				Err(
					failed(
						`${local} changed while it was sent: what arrived isn’t what was read. Send it again.`,
					),
				),
			);
		}
		return {blob: answer.blob, name, size, sha256};
	});
}

/** `pap upload`: a file of the sandbox made a blob. */
export function uploadCommand(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const [given] = parsed.positionals;
		if (given === undefined || parsed.positionals.length > 1) {
			return $(Err(usage(`Usage: ${UPLOAD}`)));
		}
		const file = $(await readLocal(io, io.absolutePath(given)));
		return $(await uploadFile(io, $(clientFrom(io)), file));
	});
}

// A blob's name as a file of the sandbox is called: the last of its path alone, so a blob never
// says where on the disk it is saved, whatever its source called it; none where it has none.
function localName(said: Json | undefined): string | null {
	const name = typeof said === 'string' ? (said.split(/[/\\]/).at(-1) ?? '').trim() : '';
	return name === '' || name === '.' || name === '..' ? null : name;
}

/** `pap download`: a blob brought into the sandbox. */
export function downloadCommand(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const [blob, to] = parsed.positionals;
		if (blob === undefined || parsed.positionals.length > 2) {
			return $(Err(usage(`Usage: ${DOWNLOAD}`)));
		}
		const answer = $(await $(clientFrom(io)).call('download', [blob]));
		const url = $(urlOf(answer));
		const name = localName(isObject(answer) ? answer.name : null) ?? blob;
		// To a path as given; into a directory, or the current one, under the blob's own name.
		const inside = to !== undefined && (to.endsWith('/') || io.isDirectory(io.absolutePath(to)));
		const named = to === undefined || inside;
		const local = io.absolutePath(
			to === undefined ? name : inside ? `${to.replace(/\/+$/, '')}/${name}` : to,
		);
		// A blob's name is its source's, an email's sender's as likely as not: it never writes over
		// a file that is there. A path given in full says which file to write.
		if (named && io.exists(local)) {
			return $(
				Err(
					failed(
						`${local} is there already, and a blob isn’t saved over a file by its own name: give the path to save it to, as pap download ${blob} <path>.`,
					),
				),
			);
		}
		const fetched = await Result.wrapAsync<Response, Error>(() => io.fetch(url, {}));
		if (fetched.isErr()) {
			return $(
				Err(failed(`Could not fetch blob ${blob}: ${errorText(fetched.error)}. Try again.`)),
			);
		}
		if (!fetched.value.ok || fetched.value.body === null) {
			return $(Err(failed(await refusalOf(fetched.value))));
		}
		const size = $(
			(await io.saveStream(local, fetched.value.body)).mapErr((cause) =>
				failed(`Could not write ${local}: ${cause.message}.`),
			),
		);
		return {file: local, blob, size};
	});
}
