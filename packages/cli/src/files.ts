import {Err, Ok, Result} from 'ts-results-es';

import {CLI_FILE_HEADER, CLI_FILES_PATH, CLI_STATUS} from '@proxy/contracts/cli-constants';
import {Do} from '@proxy/utils/do';

import type {Parsed} from './args';
import {type Client, clientFrom} from './client';
import {
	type Failure,
	failed,
	type Io,
	isObject,
	type Json,
	type JsonObject,
	refused,
	usage,
} from './io';
import {type Put, sendFile} from './send-file';

/**
 * `pap files`: a drive's files by path, for code in a sandbox, which a tool can't move: a tool's
 * answer is text, and a file is bytes. `ls` lists a folder, `pull` brings a file's bytes into the
 * sandbox, and `push` sends a file's bytes to the drive, as a new file or as the next version of
 * the one that is there, through an upload as files_upload makes one (send-file.ts).
 *
 * A push over a file is made by whoever read what it holds, as the write tool has it. pap keeps
 * that for the agent: a pull notes, beside pap's own files in the home directory, which file each
 * local path was pulled from and the version it held; a push of that path names it, so pushing
 * back what was pulled and changed just works, and is refused where the file moved on meanwhile.
 * `--force` writes over whatever is there. Either way the version before is kept in the drive.
 */

export const FILES = 'pap files <ls|pull|push>';
export const LS = 'pap files ls <connection> [path]';
export const PULL = 'pap files pull <connection> <path> [to] [--id <file>] [--version <version>]';
export const PUSH = 'pap files push <file> [<connection> <path>] [--force]';

export const FILES_HELP = `${FILES}
A drive's files by path, as Reports/2026/q3.csv, from the drive's top.
  ${LS}
      what a folder holds; the top without a path
  ${PULL}
      a file's bytes into the sandbox: into the current directory under its own name, or to a path or into a directory
      --id pulls a file by its id in place of its path; --version an earlier version of it
  ${PUSH}
      a file's bytes to the drive: back where it was pulled from, or to a path, where the folders on the way are made
      a file that is there gets its next version; --force writes over one that changed since it was pulled
The version before a push is always kept in the drive.
`;

/** Where a local file was pulled from, and the version it held then. */
type Pulled = {connection: string; id: string; version: string; path: string};

// Where pap notes what was pulled, beside its own files in the home directory.
function notesPath(io: Io): string {
	return `${io.env.HOME ?? io.absolutePath('.')}/.pap/files.json`;
}

function isPulled(value: Json | undefined): value is Pulled & JsonObject {
	return (
		isObject(value) &&
		['connection', 'id', 'version', 'path'].every((key) => typeof value[key] === 'string')
	);
}

// What was pulled, by local path; nothing where pap noted nothing yet, or its notes can't be read.
async function readNotes(io: Io): Promise<Record<string, Pulled>> {
	const text = (await io.readText(notesPath(io))).unwrapOr(null);
	const parsed =
		text === null ? undefined : Result.wrap((): Json => JSON.parse(text)).unwrapOr(undefined);
	if (!isObject(parsed)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(parsed).flatMap(([path, value]) => (isPulled(value) ? [[path, value]] : [])),
	);
}

// Notes where a local file is in the drive, and the version it holds. A note that can't be
// written is said and no failure: the next push of the file then has to say where it goes.
async function note(io: Io, local: string, pulled: Pulled): Promise<void> {
	const notes = {...(await readNotes(io)), [local]: pulled};
	const written = await io.writeFile(
		notesPath(io),
		`${JSON.stringify(notes, null, '\t')}\n`,
		0o600,
	);
	if (written.isErr()) {
		io.err(
			`pap: could not note where ${local} was pulled from (${written.error.message}); push it with its connection and path.\n`,
		);
	}
}

function messageOf(body: Json | undefined): string | null {
	return isObject(body) && typeof body.message === 'string' ? body.message : null;
}

// A response's body as JSON, or nothing where it isn't.
async function jsonOf(response: Response): Promise<Json | undefined> {
	const text = (await Result.wrapAsync<string, Error>(() => response.text())).unwrapOr('');
	return Result.wrap((): Json => JSON.parse(text)).unwrapOr(undefined);
}

// What an answer that isn't a file or a result failed with, by its status, as `pap call` says them.
async function failureOf(response: Response): Promise<Failure> {
	const said = messageOf(await jsonOf(response));
	if (response.status === CLI_STATUS.failed) {
		return failed(said ?? 'The request failed.');
	}
	if (response.status === CLI_STATUS.refused) {
		return refused(said ?? 'PAP_TOKEN was refused. Run the command again with pap: true.');
	}
	return failed(`PAP answered ${response.status}. Try again.`);
}

function filesPath(connection: string, what: string, query: Record<string, string>): string {
	const params = new URLSearchParams(query);
	return `${CLI_FILES_PATH}/${encodeURIComponent(connection)}/${what}${params.size === 0 ? '' : `?${params.toString()}`}`;
}

async function okOr(
	client: Client,
	path: string,
	init: RequestInit,
): Promise<Result<Response, Failure>> {
	const sent = await client.send(path, init);
	if (sent.isErr()) {
		return sent;
	}
	return sent.value.status === CLI_STATUS.ok ? Ok(sent.value) : Err(await failureOf(sent.value));
}

/** `pap files ls`: what a folder of the drive holds. */
export function listFiles(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const [connection, path = ''] = parsed.positionals;
		if (connection === undefined || parsed.positionals.length > 2) {
			return $(Err(usage(`Usage: ${LS}`)));
		}
		const response = $(
			await okOr($(clientFrom(io)), filesPath(connection, 'list', path === '' ? {} : {path}), {}),
		);
		return (await jsonOf(response)) ?? null;
	});
}

// Which file a pull's bytes are, as their header says.
function pulledFile(response: Response): Result<JsonObject, Failure> {
	const header = response.headers.get(CLI_FILE_HEADER);
	const said =
		header === null
			? undefined
			: Result.wrap((): Json => JSON.parse(decodeURIComponent(header))).unwrapOr(undefined);
	if (!isObject(said) || typeof said.name !== 'string') {
		return Err(failed('PAP answered without saying which file this is. Try again.'));
	}
	return Ok(said);
}

/** `pap files pull`: a file's bytes into the sandbox, and a note of where they are from. */
export function pullFile(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const {id, version} = parsed.values;
		const [connection, ...rest] = parsed.positionals;
		// By its id, what follows the connection is where to put it; by its path, the path comes first.
		const [path, to] = id === undefined ? rest : [undefined, ...rest];
		if (
			connection === undefined ||
			(id === undefined && path === undefined) ||
			rest.length > (id === undefined ? 2 : 1)
		) {
			return $(Err(usage(`Usage: ${PULL}`)));
		}
		const query = {
			...(id === undefined ? {path: path ?? ''} : {id}),
			...(version === undefined ? {} : {version}),
		};
		const response = $(await okOr($(clientFrom(io)), filesPath(connection, 'content', query), {}));
		const file = $(pulledFile(response));
		const name = String(file.name);
		// To a path as given; into a directory, or the current one, under the file's own name.
		const inside = to !== undefined && (to.endsWith('/') || io.isDirectory(io.absolutePath(to)));
		const local = io.absolutePath(
			to === undefined ? name : inside ? `${to.replace(/\/+$/, '')}/${name}` : to,
		);
		const body = response.body ?? new Response(new Uint8Array()).body;
		if (body === null) {
			return $(Err(failed('PAP answered with nothing. Try again.')));
		}
		const size = $(
			(await io.saveStream(local, body)).mapErr((cause) =>
				failed(`Could not write ${local}: ${cause.message}.`),
			),
		);
		if (
			typeof file.id === 'string' &&
			typeof file.version === 'string' &&
			typeof file.path === 'string'
		) {
			await note(io, local, {connection, id: file.id, version: file.version, path: file.path});
		}
		return {
			file: local,
			size,
			id: file.id ?? null,
			version: file.version ?? null,
			path: file.path ?? null,
		};
	});
}

// Where an upload's bytes go, as the start answered it.
function putOf(answer: Json | undefined): Result<{upload: string; put: Put}, Failure> {
	const put = isObject(answer) && isObject(answer.put) ? answer.put : undefined;
	if (
		!isObject(answer) ||
		typeof answer.upload !== 'string' ||
		put === undefined ||
		typeof put.url !== 'string' ||
		!isObject(put.headers)
	) {
		return Err(failed('PAP answered without where to send the file. Try again.'));
	}
	const headers = Object.fromEntries(
		Object.entries(put.headers).flatMap(([name, value]) =>
			typeof value === 'string' ? [[name, value]] : [],
		),
	);
	return Ok({
		upload: answer.upload,
		put: {url: put.url, headers, resumable: put.resumable === true},
	});
}

/**
 * `pap files push`: a file's bytes to the drive, back where it was pulled from or to a path. An
 * upload, as files_upload makes one: its size and SHA-256 read from disk first, the upload started
 * with them, the bytes streamed to the URL it was answered with, and the file made by done, which
 * checks what arrived against what was said.
 */
export function pushFile(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const [given, connection, path] = parsed.positionals;
		if (given === undefined || parsed.positionals.length === 2 || parsed.positionals.length > 3) {
			return $(Err(usage(`Usage: ${PUSH}`)));
		}
		const local = io.absolutePath(given);
		const pulled = (await readNotes(io))[local];
		const name = local.split('/').at(-1) ?? '';
		// Where it goes: as said, into the folder named where the path ends in a slash, or back
		// where it was pulled from.
		const target =
			connection === undefined || path === undefined
				? pulled
				: {connection, path: path.endsWith('/') ? `${path}${name}` : path};
		if (target === undefined) {
			return $(
				Err(usage(`${given} was not pulled with pap files pull, so say where it goes: ${PUSH}`)),
			);
		}
		// The version it held when it was pulled, where it goes back to the same file.
		const held =
			pulled !== undefined &&
			pulled.connection === target.connection &&
			pulled.path === target.path.replace(/^\/+/, '')
				? pulled.version
				: undefined;
		const {size, sha256} = $(
			(await io.hashFile(local)).mapErr((cause) =>
				failed(`Could not read ${given}: ${cause.message}.`),
			),
		);
		const client = $(clientFrom(io));
		const query = {
			path: target.path,
			size: String(size),
			sha256,
			...(parsed.switches.has('force') ? {force: '1'} : held === undefined ? {} : {version: held}),
		};
		const started = $(
			await okOr(client, filesPath(target.connection, 'uploads', query), {method: 'POST'}),
		);
		const {upload, put} = $(putOf(await jsonOf(started)));
		$(await sendFile(io, local, size, put));
		const response = $(
			await okOr(
				client,
				filesPath(target.connection, `uploads/${encodeURIComponent(upload)}/done`, {}),
				{method: 'POST'},
			),
		);
		const answer = await jsonOf(response);
		const file = isObject(answer) && isObject(answer.file) ? answer.file : undefined;
		if (
			file === undefined ||
			typeof file.id !== 'string' ||
			typeof file.version !== 'string' ||
			typeof file.path !== 'string'
		) {
			return $(Err(failed('PAP answered without the file it wrote. Try again.')));
		}
		await note(io, local, {
			connection: target.connection,
			id: file.id,
			version: file.version,
			path: file.path,
		});
		return {
			file: local,
			id: file.id,
			version: file.version,
			path: file.path,
			created: isObject(answer) ? (answer.created ?? null) : null,
			link: isObject(answer) ? (answer.link ?? null) : null,
		};
	});
}
