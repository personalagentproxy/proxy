import {z} from 'zod';

/**
 * What the api and a script's runner (runner.ts) say to each other, one JSON object a line, the
 * api on the runner's stdin and the runner on its stdout. The runner is a process of its own,
 * started with nothing in its environment, which runs one script in QuickJS and exits. The api
 * trusts nothing it says: each line is checked here, and the api keeps its own count of time,
 * output and calls (run-script.ts).
 *
 * - runner: `ready`, once QuickJS is loaded.
 * - api: `start`, the script and its limits.
 * - runner: `call`, a `pap` function the script called, with its arguments as JSON text, which
 *   the api answers with `answer`, the value as JSON text or what went wrong; any number at
 *   once, by `id`.
 * - runner: `log`, a line the script wrote with console.log.
 * - runner: `done`, what the script returned or threw, then it exits.
 */

export const jsonSchema = z.json();

export type Json = z.infer<typeof jsonSchema>;

/** A call's arguments, as the runner sends them. */
export const argsSchema = z.array(jsonSchema);

export const PAP_METHODS = ['connections', 'tools', 'call', 'startTask', 'finishTask', 'feedback'] as const;

export type PapMethod = (typeof PAP_METHODS)[number];

export const startMessageSchema = z.object({
	type: z.literal('start'),
	/** Plain JavaScript, the script's types stripped, wrapped in an async function the runner calls. */
	code: z.string(),
	/** How long the script may run its own code, in milliseconds, waiting on calls not counted. */
	cpuMs: z.number().int().positive(),
	memoryBytes: z.number().int().positive(),
	stackBytes: z.number().int().positive(),
});

export type StartMessage = z.infer<typeof startMessageSchema>;

export const answerMessageSchema = z.object({
	type: z.literal('answer'),
	id: z.number().int(),
	answer: z.discriminatedUnion('ok', [z.object({ok: z.literal(true), json: z.string()}), z.object({ok: z.literal(false), kind: z.string(), message: z.string()})]),
});

export type AnswerMessage = z.infer<typeof answerMessageSchema>;

export const apiMessageSchema = z.discriminatedUnion('type', [startMessageSchema, answerMessageSchema]);

/** What a script threw: an Error's name, message and where, or what it threw otherwise, as text. */
export const scriptErrorSchema = z.object({name: z.string(), message: z.string(), stack: z.string().optional()});

export type ScriptError = z.infer<typeof scriptErrorSchema>;

export const runnerMessageSchema = z.discriminatedUnion('type', [
	z.object({type: z.literal('ready')}),
	// The arguments as the script's own JSON.stringify wrote them, an array.
	z.object({type: z.literal('call'), id: z.number().int(), method: z.enum(PAP_METHODS), argsJson: z.string()}),
	z.object({type: z.literal('log'), text: z.string()}),
	z.object({
		type: z.literal('done'),
		outcome: z.discriminatedUnion('ok', [z.object({ok: z.literal(true), json: z.string()}), z.object({ok: z.literal(false), error: scriptErrorSchema})]),
	}),
]);

export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
