import {z} from 'zod';

/**
 * The sandbox protocol: how the api reaches a sandbox backend run as a service elsewhere
 * (`@proxy/backends/sandbox/remote`), and how such a service answers, one route per
 * method of the contract (`…/backend`), each a JSON body in and out, with
 * `Authorization: Bearer <token>`:
 * - `POST /sandboxes` with `createSandboxBodySchema`: a new sandbox, running; its ref.
 * - `POST /sandboxes/:ref/exec` with `execSandboxBodySchema`: a command run; what it wrote.
 * - `POST /sandboxes/:ref/sleep` and `…/wake`, no body: the ref from then on.
 * - `DELETE /sandboxes/:ref`: gone; an empty object.
 * - `GET /health`, without the token: `{ok: true}`.
 * A ref goes in the path URL-encoded. What went wrong comes as `sandboxErrorSchema` with the
 * status the error's kind has in the api (`ApiError`); the client takes it back to that kind.
 */

export const createSandboxBodySchema = z.object({
	/** Whose the sandbox is: the organization's id. */
	tenant: z.string().min(1),
	/** The id the api gave the sandbox. */
	sandboxId: z.string().min(1),
});

export type CreateSandboxBody = z.infer<typeof createSandboxBodySchema>;

export const sandboxRefSchema = z.object({ref: z.string().min(1)});

export const execSandboxBodySchema = z.object({
	command: z.string(),
	stdin: z.string().optional(),
	cwd: z.string().optional(),
	timeoutMs: z.number().int().positive(),
});

export type ExecSandboxBody = z.infer<typeof execSandboxBodySchema>;

export const sandboxOutputSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	exitCode: z.number().int().nullable(),
	timedOut: z.boolean(),
});

export const sandboxDestroyedSchema = z.object({});

export const sandboxHealthSchema = z.object({ok: z.literal(true)});

/** What went wrong, by the api's kind of error, with what to do next where the service says. */
export const sandboxErrorSchema = z.object({
	error: z.object({kind: z.string(), message: z.string().optional()}),
});

export type SandboxError = z.infer<typeof sandboxErrorSchema>;
