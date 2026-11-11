/**
 * The CLI's routes' constants (cli.ts), apart from its schemas so the `pap` binary
 * (packages/cli), which every sandbox command loads, can import them without zod.
 */

/** The `pap` functions, a script's and the CLI's alike. */
export const PAP_METHODS = [
	'connections',
	'tools',
	'call',
	'startTask',
	'finishTask',
	'feedback',
] as const;

export type PapMethod = (typeof PAP_METHODS)[number];

/** Where a `pap` function is called, under `PAP_URL`. */
export const CLI_CALL_PATH = '/api/cli/call';

/** The statuses `/api/cli/call` answers with. */
export const CLI_STATUS = {ok: 200, failed: 422, refused: 401} as const;

/**
 * Where the files of a drive are reached by path, under `PAP_URL` (cli.ts): `<this>/<connection>/list`
 * and `<this>/<connection>/content`.
 */
export const CLI_FILES_PATH = '/api/cli/files';

/** The header a file's bytes come with, saying which file they are: URI-encoded JSON (`cliFileSchema` in cli.ts). */
export const CLI_FILE_HEADER = 'x-pap-file';
