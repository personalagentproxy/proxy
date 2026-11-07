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
	return `${text.slice(0, MAX_ANSWER_CHARS)}\n\n[Cut at ${MAX_ANSWER_CHARS} of ${text.length} characters.]`;
}

function stopped(reason: 'timeout' | 'output' | 'crashed' | 'protocol', limits: ScriptLimits): string {
	if (reason === 'timeout') {
		return `Stopped after ${Math.round(limits.wallMs / 1000)} s; its calls until then took effect.`;
	}
	if (reason === 'output') {
		return `Stopped: over ${Math.round(limits.maxOutputBytes / 1_000_000)} MB of output; its calls until then took effect.`;
	}
	return 'Stopped unexpectedly; its calls until then took effect.';
}

/** The run in words, and whether it failed. */
export function describeRun(run: ScriptRun, startedTask: string | null, limits: ScriptLimits): {text: string; isError: boolean} {
	const parts: string[] = [];
	if (run.logs.length > 0) {
		parts.push(run.logs.join('\n'));
	}
	const {outcome} = run;
	if (outcome.type === 'returned') {
		parts.push(run.logs.length > 0 ? `Returned: ${outcome.json}` : outcome.json);
	}
	if (outcome.type === 'threw') {
		const where = outcome.error.stack ? `\n${outcome.error.stack}` : '';
		parts.push(`${outcome.error.name}: ${outcome.error.message}${where}`);
	}
	if (outcome.type === 'stopped') {
		parts.push(stopped(outcome.reason, limits));
	}
	if (startedTask !== null) {
		parts.push(`Task: ${startedTask}`);
	}
	return {text: cut(parts.join('\n\n')), isError: outcome.type !== 'returned'};
}
