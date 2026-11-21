import {Err, Ok, Result} from 'ts-results-es';

import {
	CLI_EXPORTS,
	CLI_FILE_HEADER,
	CLI_FILES_PATH,
	CLI_STATUS,
} from '@proxy/contracts/cli-constants';
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
import {readLocal, uploadFile} from './blobs';

/**
 * `pap files`: a drive's files by path, for code in a sandbox. `ls` lists a folder, `pull` brings
 * a file's bytes into the sandbox, and `push` puts a file in the drive, as a new file or as the
 * next version of the one that is there: asked about before any of it is sent, then made a blob,
 * as `pap upload` makes one (blobs.ts), and the blob put in the drive, as files_upload puts one. A drive is a Files connection or a
 * Google one, whose paths start at Drive's own places, as `My Drive/Reports/q3.pdf`; a Google Doc,
 * Sheet or Slides file comes down as Drive exports it, and a new file pushed can be made one.
 *
 * A push over a file is made by whoever read what it holds, as the write tool has it. pap keeps
 * that for the agent: a pull notes, beside pap's own files in the home directory, which file each
 * local path was pulled from, the version it held, and what it was exported as, where it was; a
 * push of that path names the version, so pushing back what was pulled and changed just works, and
 * is refused where the file moved on meanwhile. `--force` writes over whatever is there. Either way
 * the version before is kept in the drive.
 */

export const FILES = 'pap files <ls|pull|push>';
export const LS = 'pap files ls <connection> [path]';
export const PULL =
	'pap files pull <connection> <path> [to] [--id <file>] [--version <version>] [--as <format>] [--tab <tab>]';
export const PUSH =
	'pap files push <file> [<connection> <path>] [--id <file>] [--convert] [--force]';

export const FILES_HELP = `${FILES}
A drive's files by path, as Reports/2026/q3.csv, from the drive's top. A Google connection's Drive
starts at its places: My Drive/Reports/q3.pdf, Shared drives/<drive>/..., Shared with me/...
  ${LS}
      what a folder holds; the top without a path
  ${PULL}
      a file's bytes into the sandbox: into the current directory under its own name, or to a path or into a directory
      --id pulls a file by its id or its link in place of its path; --version an earlier version of it
      a Google Doc comes as .md, a Sheet as .xlsx and a Slides file as .pptx, named with the extension;
      --as for another: a Doc as md, docx, pdf or txt, a Sheet as xlsx, csv or pdf, a Slides file as pptx, pdf or txt;
      a Sheet as csv is its first tab, or the one --tab names
  ${PUSH}
      a file's bytes to the drive: back where it was pulled from, or to a path, where the folders on the way are made
      a file that is there gets its next version; --force writes over one that changed since it was pulled;
      --id writes over the file of that id, on the connection given or the one it was pulled from
      into Google Drive, a new file goes up as its bytes; --convert makes it a Doc (of a .docx or .md), a
      Sheet (.xlsx or .csv) or a Slides file (.pptx). A Doc, Sheet or Slides file is never pushed over: edit
      a Doc in place with the docs_edit tool, a Sheet's cells with ranges_write, a Slides file's text with
      slides_edit, or push the file to a new path with --convert
Where a name matches more than one file, as Google Drive allows, the ids are listed: name the file with --id.
The version before a push is always kept in the drive.
`;

/** Where a local file was pulled from, the version it held then, and what it was exported as, where it was. */
type Pulled = {connection: string; id: string; version: string; path: string; format?: string};

// Where pap notes what was pulled, beside its own files in the home directory.
function notesPath(io: Io): string {
	return `${io.env.HOME ?? io.absolutePath('.')}/.pap/files.json`;
}

function isPulled(value: Json | undefined): value is Pulled & JsonObject {
	return (
		isObject(value) &&
		['connection', 'id', 'version', 'path'].every((key) => typeof value[key] === 'string') &&
		(value.format === undefined || typeof value.format === 'string')
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

// A flag's value, where it is one of those it takes.
function oneOf<T extends string>(
	flag: string,
	value: string | undefined,
	values: readonly T[],
): Result<T | undefined, Failure> {
	const found = values.find((one) => one === value);
	if (value !== undefined && found === undefined) {
		return Err(usage(`--${flag} takes ${values.join(', ')}, not ${value}.`));
	}
	return Ok(found);
}

/** `pap files pull`: a file's bytes into the sandbox, and a note of where they are from. */
export function pullFile(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const {id, version, tab} = parsed.values;
		const as = $(oneOf('as', parsed.values.as, CLI_EXPORTS));
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
			...(as === undefined ? {} : {as}),
			...(tab === undefined ? {} : {tab}),
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
		const format = typeof file.format === 'string' ? file.format : undefined;
		if (
			typeof file.id === 'string' &&
			typeof file.version === 'string' &&
			typeof file.path === 'string'
		) {
			await note(io, local, {
				connection,
				id: file.id,
				version: file.version,
				path: file.path,
				...(format === undefined ? {} : {format}),
			});
		}
		return {
			file: local,
			size,
			id: file.id ?? null,
			version: file.version ?? null,
			path: file.path ?? null,
			...(format === undefined ? {} : {format}),
		};
	});
}

// Where a push goes: the file of an id, on a connection, or a path.
type PushTarget = {connection: string; id: string} | {connection: string; path: string};

// Where a push goes, as it was said, or back where the file was pulled from; and the version it
// held then, where it goes back to that file.
function pushTarget(
	parsed: Parsed,
	given: string,
	name: string,
	pulled: Pulled | undefined,
): Result<{target: PushTarget; held: string | undefined}, Failure> {
	const [, connection, path] = parsed.positionals;
	const {id} = parsed.values;
	if (id !== undefined) {
		const on = connection ?? pulled?.connection;
		if (on === undefined) {
			return Err(
				usage(
					`${given} was not pulled with pap files pull, so say which connection it goes to: ${PUSH}`,
				),
			);
		}
		const held = pulled?.connection === on && pulled.id === id ? pulled.version : undefined;
		return Ok({target: {connection: on, id}, held});
	}
	// As said, into the folder named where the path ends in a slash, or back where it was pulled from.
	const target =
		connection === undefined || path === undefined
			? pulled
			: {connection, path: path.endsWith('/') ? `${path}${name}` : path};
	if (target === undefined) {
		return Err(usage(`${given} was not pulled with pap files pull, so say where it goes: ${PUSH}`));
	}
	const held =
		pulled !== undefined &&
		pulled.connection === target.connection &&
		pulled.path === target.path.replace(/^\/+/, '')
			? pulled.version
			: undefined;
	return Ok({target: {connection: target.connection, path: target.path}, held});
}

/**
 * `pap files push`: a file put in the drive, back where it was pulled from, at a path, or over the
 * file of an id: asked about first, so a push the drive would refuse sends none of the file; then
 * made a blob, its SHA-256 checked against what arrived, and the blob put there, the version pulled
 * named where it goes back over the file it was pulled from.
 */
export function pushFile(parsed: Parsed, io: Io): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const [given] = parsed.positionals;
		const count = parsed.positionals.length;
		const byId = parsed.values.id !== undefined;
		if (given === undefined || (byId ? count > 2 : count === 2 || count > 3)) {
			return $(Err(usage(`Usage: ${PUSH}`)));
		}
		const local = io.absolutePath(given);
		const pulled = (await readNotes(io))[local];
		const name = local.split('/').at(-1) ?? '';
		const {target, held} = $(pushTarget(parsed, given, name, pulled));
		const client = $(clientFrom(io));
		const read = $(await readLocal(io, local));
		const where = {
			...('id' in target ? {id: target.id} : {path: target.path}),
			...(parsed.switches.has('convert') ? {convert: '1'} : {}),
			...(parsed.switches.has('force') ? {force: '1'} : held === undefined ? {} : {version: held}),
		};
		// Asked about before the file is sent, so a push that would be refused sends nothing.
		const asked = {file: name, size: String(read.size), ...where};
		$(await okOr(client, filesPath(target.connection, 'push/check', asked), {method: 'POST'}));
		const {blob} = $(await uploadFile(io, client, read));
		const response = $(
			await okOr(client, filesPath(target.connection, 'push', {blob, ...where}), {method: 'POST'}),
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
