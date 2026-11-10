import {z} from 'zod';

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
 * - 200, `cliCallResultSchema`: `{result}`, what the function answered, as JSON.
 * - 422, `cliCallFailureSchema`: `{error, message}`, the call failed: a tool refused or failing, a
 *   method or arguments that aren't right, or a body that isn't JSON; `error` the kind of error and
 *   `message` what to do, in words for a model.
 * - 401, `cliRefusalSchema`: the token is missing, not valid or expired, or what it names is no
 *   longer so (the agent revoked, the task ended, the sandbox another task's); `message` says how
 *   to get a new one. Run the command again with `pap: true`.
 * Anything else is the server failing, such as a 500.
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

/** `POST /api/cli/call`: the function, and its arguments as a script passes them, none where left out. */
export const cliCallBodySchema = z.object({
	method: z.enum(PAP_METHODS),
	args: z.array(z.json()).default([]),
});

export type CliCallBody = z.input<typeof cliCallBodySchema>;

/** 200: what the function answered. */
export const cliCallResultSchema = z.object({result: z.json()});

export type CliCallResult = z.infer<typeof cliCallResultSchema>;

/** 422: the call failed, `error` the kind of error and `message` what went wrong, for a model. */
export const cliCallFailureSchema = z.object({error: z.string(), message: z.string()});

export type CliCallFailure = z.infer<typeof cliCallFailureSchema>;

/** 401: the token doesn't work, `message` saying how to get one that does. */
export const cliRefusalSchema = z.object({
	error: z.literal('unauthenticated'),
	message: z.string(),
});

export type CliRefusal = z.infer<typeof cliRefusalSchema>;

/** The statuses `/api/cli/call` answers with. */
export const CLI_STATUS = {ok: 200, failed: 422, refused: 401} as const;
