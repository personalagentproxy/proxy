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
 * Where the files of a drive are reached by path, under `PAP_URL` (cli.ts): `<this>/<connection>/list`,
 * `<this>/<connection>/content`, and `<this>/<connection>/uploads` with `…/uploads/<upload>/done`.
 */
export const CLI_FILES_PATH = '/api/cli/files';

/** The header a file's bytes come with, saying which file they are: URI-encoded JSON (`cliPulledSchema` in cli.ts). */
export const CLI_FILE_HEADER = 'x-pap-file';

/** What a Google Doc, Sheet or Slides file is pulled as: `pap files pull --as`. */
export const CLI_EXPORTS = ['md', 'docx', 'pdf', 'xlsx', 'csv', 'pptx', 'txt'] as const;

export type CliExport = (typeof CLI_EXPORTS)[number];

/** What a new file pushed to Google Drive is made into: `pap files push --as`. */
export const CLI_CONVERSIONS = ['doc', 'sheet', 'slides'] as const;

export type CliConversion = (typeof CLI_CONVERSIONS)[number];
