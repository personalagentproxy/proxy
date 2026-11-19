import {z} from 'zod';

import {CLI_CONVERSIONS, CLI_EXPORTS, PAP_METHODS} from './cli-constants';

export {
	CLI_CALL_PATH,
	CLI_CONVERSIONS,
	CLI_EXPORTS,
	CLI_FILE_HEADER,
	CLI_FILES_PATH,
	CLI_STATUS,
	type CliConversion,
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
 * - `{method: 'call', args: [connection, tool, params?]}`: runs a tool, logged under the token's task.
 * - `{method: 'feedback', args: [{message, connection?, tool?}]}`: feedback for the makers.
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
 * - `POST …/uploads?path=&size=&sha256=`: starts an upload of a file to the path, its size in
 *   bytes and its SHA-256 in hex said first, as files_upload does (@proxy/contracts/uploads): a
 *   new file there, the folders on the way made where they are missing; or, where a file is
 *   there, its next version, by whoever names the version it holds (`&version=`), as the write tool
 *   takes it, or says `&force=1` to write over what it holds now. `&id=` in place of the path
 *   writes over the file of that id. `&file=` is the local file's name, whose extension says what
 *   its bytes are, and `&as=` makes a new file in Google Drive a Doc, Sheet or Slides file.
 *   Answers `cliUploadStartedSchema`: where to PUT the bytes, in one request, which needs no
 *   token.
 * - `POST …/uploads/<upload>/done`: makes the file of the bytes that arrived, once they are
 *   checked against what was said, as files_upload_done does. Answers `cliPushedSchema`.
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

export const cliUploadQuerySchema = z
	.object({
		path: z.string().min(1).max(2000).optional(),
		id: z.string().min(1).optional(),
		size: z.coerce.number().int().nonnegative(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		version: z.string().min(1).optional(),
		force: z.enum(['1']).optional(),
		file: z.string().min(1).max(2000).optional(),
		as: z.enum(CLI_CONVERSIONS).optional(),
	})
	.refine(({path, id}) => (path === undefined) !== (id === undefined), {
		message: 'Name where the file goes by path or by id, one of them',
	});

export const cliUploadStartedSchema = z.object({
	/** The upload's id, which `…/uploads/<upload>/done` takes. */
	upload: z.string(),
	/** Where the bytes go: the URL with the headers to send there, and until when. */
	put: z.object({
		url: z.string(),
		method: z.literal('PUT'),
		headers: z.record(z.string(), z.string()),
		expiresAt: z.string(),
	}),
});

export type CliUploadStarted = z.infer<typeof cliUploadStartedSchema>;
