import {z} from 'zod';

import {CLI_EXPORTS, PAP_METHODS} from './cli-constants';

export {
	CLI_CALL_PATH,
	CLI_EXPORTS,
	CLI_FILE_HEADER,
	CLI_FILES_PATH,
	CLI_STATUS,
	type CliExport,
	PAP_METHODS,
	type PapMethod,
} from './cli-constants';

/**
 * The CLI's routes (`/api/cli/…`), for code in a sandbox: what the `script` tool's `pap` object
 * does, over HTTP. A sandbox command run with `pap: true` is given `PAP_URL`, where this server is
 * opened, and `PAP_TOKEN`, which every request sends as `Authorization: Bearer <token>`. The token
 * is the agent's, for the task the command was run for, while the sandbox is still that task's, and
 * lasts as long as the command; there is no cookie and no Origin check.
 *
 * `POST /api/cli/call` with `cliCallBodySchema`, `{method, args}`, a `pap` function and its
 * arguments as a script passes them:
 * - `{method: 'connections', args: []}`: the connections the agent can use, a sandbox's own
 *   Sandboxes connection left out.
 * - `{method: 'tools', args: [connection]}`: a connection's tools.
 * - `{method: 'refreshTools', args: [connection]}`: a custom MCP server's tools asked for again,
 *   `{tools, notAllowed}`: those the agent has now, and the names of the rest.
 * - `{method: 'call', args: [connection, tool, params?]}`: runs a tool, logged under the token's task.
 * - `{method: 'feedback', args: [{message, connection?, tool?}]}`: feedback for the makers.
 * - `{method: 'upload', args: []}`: a URL to PUT files to, each made a blob of the agent's
 *   (@proxy/contracts/blobs `blobUploadSchema`).
 * - `{method: 'download', args: [blob]}`: a URL to GET one of the agent's blobs from
 *   (`blobDownloadSchema`).
 * `startTask` and `finishTask` are refused: the token's task is the one used.
 *
 * Answered with one of three statuses, so a client can tell them apart without reading the words:
 * - 200: `{result}`, what the function answered, as JSON.
 * - 422, `CliCallFailure`: `{error, message}`, the call failed: a tool refused or failing, a
 *   method or arguments that aren't right, or a body that isn't JSON; `error` the kind of error and
 *   `message` what to do, in words for a model.
 * - 401: `{error: 'unauthenticated', message}`, the token is missing, not valid or expired, or
 *   what it names is no longer so (the agent revoked, the task ended, the sandbox another task's);
 *   `message` says how to get a new one. Run the command again with `pap: true`.
 * Anything else is the server failing, such as a 500.
 */

/** `POST /api/cli/call`: the function, and its arguments as a script passes them, none where left out. */
export const cliCallBodySchema = z.object({
	method: z.enum(PAP_METHODS),
	args: z.array(z.json()).default([]),
});

export type CliCallBody = z.input<typeof cliCallBodySchema>;

/** 422: the call failed, `error` the kind of error and `message` what went wrong, for a model. */
export type CliCallFailure = {error: string; message: string};

/**
 * A drive's files by path, for code in a sandbox (`/api/cli/files/:connection/…`), which a tool
 * can't carry: a tool's answer is text, and a file is bytes. A drive is a Files connection or a
 * Google one. With the same token, through the same gate and into the same log as a tool run:
 * listing and reading need Read files, a new file Add files, and writing over one Edit files. A
 * path is the names from the drive's top with `/` between them, as `Reports/2026/q3.csv`; the top
 * is the empty path. Google Drive's top holds its own three places, so a path there starts with
 * one: `My Drive/Reports/q3.pdf`, `Shared drives/<drive>/…` or `Shared with me/…`. Where a name
 * matches more than one file, as Drive allows, the path is refused with their ids, and the file is
 * named by its id instead. Answered with the statuses `/api/cli/call` uses: 200, 422 with
 * `{error, message}` for what went wrong, in words for a model, and 401 for the token.
 * - `GET …/list?path=`: what the folder holds (`cliFileListSchema`).
 * - `GET …/content?path=` or `?id=`, with `&version=` for an earlier version: the file's bytes,
 *   and which file they are in the `x-pap-file` header (`cliPulledSchema`, URI-encoded JSON). A
 *   Google Doc, Sheet or Slides file has no bytes of its own, and comes as Drive exports it: as
 *   `&as=` says (`cliPullQuerySchema`), else a Doc as Markdown, a Sheet as xlsx and a Slides file
 *   as pptx; a Sheet as CSV is its first tab, or the one `&tab=` names.
 * - `POST …/push?blob=&path=`: puts one of the agent's blobs, sent first to the URL `upload`
 *   answers with, in the drive at the path, as files_upload does: a new file there, the folders
 *   on the way made where they are missing; or, where a file is there, its next version, by
 *   whoever names the version it holds (`&version=`), as the write tool takes it, or says
 *   `&force=1` to write over what it holds now. `&id=` in place of the path writes over the file
 *   of that id, and `&convert=1` makes a new file in Google Drive a Doc, Sheet or Slides file.
 *   Answers `cliPushedSchema`.
 * - `POST …/push/check?file=&size=&path=`: asks about that push before the file is sent, with
 *   the local file's name and its size in bytes in place of the blob, and the rest as the push
 *   says it. Nothing is made: it is refused with what the push would be refused for, the agent's
 *   access, the path, the version, the size or what the drive takes there, and otherwise answers
 *   `{}`.
 */
export const cliFileSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** Where it is, from the drive's top. */
	path: z.string(),
	folder: z.boolean(),
	/** What a file holds: its version's id, its size in bytes and its media type; null for a folder. */
	version: z.string().nullable(),
	size: z.number().nullable(),
	type: z.string().nullable(),
});

export type CliFile = z.infer<typeof cliFileSchema>;

export const cliFileListSchema = z.object({
	path: z.string(),
	files: z.array(cliFileSchema),
	/** Whether the folder holds more than are listed, as a Google Drive folder of thousands may. */
	more: z.boolean().optional(),
});

/** A file pulled: which it is, and what it was exported as, where it has no bytes of its own. */
export const cliPulledSchema = cliFileSchema.extend({
	/** What a Google Doc, Sheet or Slides file was exported as (`CLI_EXPORTS`); null for bytes as they are. */
	format: z.string().nullable(),
});

export type CliPulled = z.infer<typeof cliPulledSchema>;

export const cliPushedSchema = z.object({
	file: cliFileSchema,
	/** Whether the file is new, rather than a new version of one that was there. */
	created: z.boolean(),
	/** The page the person opens it on. */
	link: z.string(),
});

export const cliListQuerySchema = z.object({path: z.string().max(2000).default('')});

export const cliPullQuerySchema = z
	.object({
		path: z.string().min(1).max(2000).optional(),
		id: z.string().min(1).optional(),
		version: z.string().min(1).optional(),
		as: z.enum(CLI_EXPORTS).optional(),
		tab: z.string().min(1).max(200).optional(),
	})
	.refine(({path, id}) => (path === undefined) !== (id === undefined), {
		message: 'Name the file by path or by id, one of them',
	});

export type CliPushed = z.infer<typeof cliPushedSchema>;

// Where a push goes and how, the same asked about before the file is sent and once it is a blob.
const pushWhere = {
	path: z.string().min(1).max(2000).optional(),
	id: z.string().min(1).optional(),
	version: z.string().min(1).optional(),
	force: z.enum(['1']).optional(),
	convert: z.enum(['1']).optional(),
};

const PATH_OR_ID = 'Name where the file goes by path or by id, one of them';

function pathOrId({path, id}: {path?: string; id?: string}): boolean {
	return (path === undefined) !== (id === undefined);
}

export const cliPushQuerySchema = z
	.object({blob: z.string().min(1), ...pushWhere})
	.refine(pathOrId, {message: PATH_OR_ID});

export const cliPushCheckQuerySchema = z
	.object({
		file: z.string().min(1).max(2000),
		size: z.coerce.number().int().nonnegative(),
		...pushWhere,
	})
	.refine(pathOrId, {message: PATH_OR_ID});
