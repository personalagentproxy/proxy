import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

import type {Subprocess} from 'bun';
import {transform} from 'sucrase';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {readLines} from './lines';
import {argsSchema, type Json, type PapMethod, runnerMessageSchema, type RunnerMessage, type ScriptError} from './protocol';

/**
 * Runs an agent's script: TypeScript or JavaScript whose `pap` functions are the agent's tools,
 * answered by `host` for the agent and its task. The script runs in a runner of its own
 * (runner.ts), a process with nothing in its environment, in QuickJS, and is stopped at the
 * first of its limits: its code running too long or the whole run taking too long, too much
 * memory, stack or output, or too many calls. Every limit that matters is kept here, where the
 * script can't reach, whatever the runner says: the wall clock, the output, the calls, and how
 * many of them run at once. A runner is used for one script and exits; the next one is already
 * started, so a script doesn't wait for QuickJS to load.
 */

export type ScriptLimits = {
	/** The whole run, waiting on calls counted. */
	wallMs: number;
	/** The script's own code, waiting on calls not counted. */
	cpuMs: number;
	memoryBytes: number;
	stackBytes: number;
	maxCalls: number;
	maxConcurrentCalls: number;
	/** Everything the runner writes: the result, the lines logged and the calls. */
	maxOutputBytes: number;
};

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
	// Long enough to wait on a sandbox command, which may run for up to two minutes.
	wallMs: 150_000,
	cpuMs: 10_000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	maxCalls: 200,
	maxConcurrentCalls: 8,
	maxOutputBytes: 2_000_000,
};

/** One `pap` function as the api answers it: the value as JSON text, or what went wrong. */
export type PapAnswer = Result<string, {kind: string; message: string}>;

/** Answers the script's `pap` calls, for the agent and the task the run is for. */
export type ScriptHost = (method: PapMethod, args: Json[]) => Promise<PapAnswer>;

export type ScriptOutcome =
	| {type: 'returned'; json: string}
	| {type: 'threw'; error: ScriptError}
	/** Stopped from here: the run took too long, wrote too much, or the runner died or broke the protocol. */
	| {type: 'stopped'; reason: 'timeout' | 'output' | 'crashed' | 'protocol'};

export type ScriptRun = {outcome: ScriptOutcome; logs: string[]; calls: number; durationMs: number};

const RUNNER_PATH = fileURLToPath(new URL('./runner.ts', import.meta.url));

type Runner = {process: Subprocess<'pipe', 'pipe', 'ignore'>; lines: AsyncGenerator<string>; budget: {bytes: number; max: number}};

function spawnRunner(maxOutputBytes: number): Result<Runner, ApiError> {
	const spawned = Result.wrap(() => Bun.spawn([process.execPath, RUNNER_PATH], {stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: {}, cwd: tmpdir()}));
	if (spawned.isErr()) {
		return Err(ApiErr.internalError(spawned.error instanceof Error ? spawned.error : new Error('The script runner could not be started')));
	}
	const budget = {bytes: 0, max: maxOutputBytes};
	return Ok({process: spawned.value, lines: readLines(spawned.value.stdout, budget), budget});
}

// The runner started for the next script, while it loads QuickJS.
let spare: Runner | null = null;

function takeRunner(maxOutputBytes: number): Result<Runner, ApiError> {
	const ready = spare !== null && spare.process.exitCode === null && spare.budget.max === maxOutputBytes ? spare : null;
	if (spare !== null && ready === null) {
		spare.process.kill(9);
	}
	const next = spawnRunner(maxOutputBytes);
	spare = next.isOk() ? next.value : null;
	if (ready !== null) {
		return Ok(ready);
	}
	return spawnRunner(maxOutputBytes);
}

// How many lines of a stack the agent is told: where it was thrown, and how it got there.
const MAX_STACK_LINES = 10;

// The script as the runner takes it: in an async function, so it can await and return, opened
// on its first line so every line keeps its number, and its types stripped, the rest of it left
// as it was; one that doesn't parse as it was written.
function compile(source: string): Result<string, ScriptError> {
	const compiled = Result.wrap(() => transform(`(async () => {${source}\n})()`, {transforms: ['typescript'], disableESTransforms: true}).code);
	if (compiled.isErr()) {
		const message = compiled.error instanceof Error ? compiled.error.message : 'The script could not be read.';
		return Err({name: 'SyntaxError', message});
	}
	return Ok(compiled.value);
}

function trimStack(error: ScriptError): ScriptError {
	if (error.stack === undefined) {
		return error;
	}
	const lines = error.stack.split('\n').filter((line) => line.trim() !== '');
	if (lines.length <= MAX_STACK_LINES) {
		return {...error, stack: lines.join('\n')};
	}
	return {...error, stack: [...lines.slice(0, MAX_STACK_LINES), `    … ${lines.length - MAX_STACK_LINES} more`].join('\n')};
}

function parseMessage(line: string): RunnerMessage | null {
	const json = Result.wrap((): Json => JSON.parse(line));
	if (json.isErr()) {
		return null;
	}
	const parsed = runnerMessageSchema.safeParse(json.value);
	return parsed.success ? parsed.data : null;
}

function parseArgs(argsJson: string): Json[] | null {
	const json = Result.wrap((): Json => JSON.parse(argsJson));
	if (json.isErr()) {
		return null;
	}
	const parsed = argsSchema.safeParse(json.value);
	return parsed.success ? parsed.data : null;
}

export async function runScript(source: string, host: ScriptHost, limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS): Promise<Result<ScriptRun, ApiError>> {
	const startedAt = performance.now();
	const logs: string[] = [];
	let calls = 0;
	const finished = (outcome: ScriptOutcome): Result<ScriptRun, ApiError> => Ok({outcome, logs, calls, durationMs: Math.round(performance.now() - startedAt)});

	const code = compile(source);
	if (code.isErr()) {
		return finished({type: 'threw', error: code.error});
	}
	const taken = takeRunner(limits.maxOutputBytes);
	if (taken.isErr()) {
		return taken;
	}
	const runner = taken.value;
	const write = (message: object) => {
		if (runner.process.exitCode !== null) {
			return;
		}
		runner.process.stdin.write(`${JSON.stringify(message)}\n`);
		void runner.process.stdin.flush();
	};

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		runner.process.kill(9);
	}, limits.wallMs);

	// The calls past the first `maxConcurrentCalls` wait their turn here.
	let running = 0;
	const waiting: Array<() => void> = [];
	const answer = async (id: number, method: PapMethod, args: Json[]) => {
		running++;
		const answered = await Result.wrapAsync(() => host(method, args));
		running--;
		waiting.shift()?.();
		if (answered.isErr()) {
			write({type: 'answer', id, answer: {ok: false, kind: 'internal_error', message: 'Something went wrong. Try again in a moment.'}});
			return;
		}
		const result = answered.value;
		write({type: 'answer', id, answer: result.isOk() ? {ok: true, json: result.value} : {ok: false, ...result.error}});
	};

	const ready = await runner.lines.next();
	if (ready.done || parseMessage(ready.value)?.type !== 'ready') {
		clearTimeout(timer);
		runner.process.kill(9);
		return Err(ApiErr.internalError(new Error('The script runner did not start')));
	}
	write({type: 'start', code: code.value, cpuMs: limits.cpuMs, memoryBytes: limits.memoryBytes, stackBytes: limits.stackBytes});

	let outcome: ScriptOutcome | null = null;
	for await (const line of runner.lines) {
		const message = parseMessage(line);
		if (message === null || message.type === 'ready') {
			outcome = {type: 'stopped', reason: 'protocol'};
			break;
		}
		if (message.type === 'done') {
			outcome = message.outcome.ok ? {type: 'returned', json: message.outcome.json} : {type: 'threw', error: trimStack(message.outcome.error)};
			break;
		}
		if (message.type === 'log') {
			logs.push(message.text);
			continue;
		}
		const args = parseArgs(message.argsJson);
		if (args === null) {
			outcome = {type: 'stopped', reason: 'protocol'};
			break;
		}
		calls++;
		if (calls > limits.maxCalls) {
			write({type: 'answer', id: message.id, answer: {ok: false, kind: 'too_many_calls', message: `A script may make ${limits.maxCalls} calls; this one made more. Do the rest in another script.`}});
			continue;
		}
		const call = () => void answer(message.id, message.method, args);
		if (running < limits.maxConcurrentCalls) {
			call();
			continue;
		}
		waiting.push(call);
	}
	clearTimeout(timer);
	runner.process.kill(9);

	if (outcome !== null) {
		return finished(outcome);
	}
	if (timedOut) {
		return finished({type: 'stopped', reason: 'timeout'});
	}
	if (runner.budget.bytes > runner.budget.max) {
		return finished({type: 'stopped', reason: 'output'});
	}
	return finished({type: 'stopped', reason: 'crashed'});
}
