import type {ScriptLimits, ScriptRun} from './run-script';

/**
 * A script's run as the model reads it: what it logged, then what it returned, or what it threw
 * and where, or why it was stopped; and the task it started, where it did, since every later
 * script for that task needs its id.
 */

// How much of an answer the model is given; the built-in agent's loop cuts it further.
const MAX_ANSWER_CHARS = 100_000;

function cut(text: string): string {
	if (text.length <= MAX_ANSWER_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_ANSWER_CHARS)}\n\n[Cut: the answer was ${text.length} characters long. Return only what you need, such as the fields you will use.]`;
}

function stopped(reason: 'timeout' | 'output' | 'crashed' | 'protocol', limits: ScriptLimits): string {
	if (reason === 'timeout') {
		return `The script was stopped after ${Math.round(limits.wallMs / 1000)} seconds, before it finished. What it did until then was done: check before doing it again, and do long work in several scripts.`;
	}
	if (reason === 'output') {
		return `The script was stopped: it wrote more than ${Math.round(limits.maxOutputBytes / 1_000_000)} MB. What it did until then was done. Return and log less, such as only the fields you need.`;
	}
	return 'The script stopped unexpectedly. What it did until then was done: check before running it again.';
}

/** The run in words, and whether it failed. */
export function describeRun(run: ScriptRun, startedTask: string | null, limits: ScriptLimits): {text: string; isError: boolean} {
	const parts: string[] = [];
	if (run.logs.length > 0) {
		parts.push(`Logged:\n${run.logs.join('\n')}`);
	}
	const {outcome} = run;
	if (outcome.type === 'returned') {
		parts.push(run.logs.length > 0 ? `Returned:\n${outcome.json}` : outcome.json);
	}
	if (outcome.type === 'threw') {
		const where = outcome.error.stack ? `\n${outcome.error.stack}` : '';
		parts.push(`The script threw ${outcome.error.name}: ${outcome.error.message}${where}`);
	}
	if (outcome.type === 'stopped') {
		parts.push(stopped(outcome.reason, limits));
	}
	if (startedTask !== null) {
		parts.push(`This script started the task ${startedTask}: give it as task to the next scripts for it.`);
	}
	return {text: cut(parts.join('\n\n')), isError: outcome.type !== 'returned'};
}
