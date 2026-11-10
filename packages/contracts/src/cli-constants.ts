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
