import {describe, expect, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import type {Json, PapMethod} from './protocol';
import {DEFAULT_SCRIPT_LIMITS, type PapAnswer, runScript, type ScriptHost, type ScriptLimits, type ScriptRun} from './run-script';

const LIMITS: ScriptLimits = {...DEFAULT_SCRIPT_LIMITS, wallMs: 5_000, cpuMs: 500, memoryBytes: 16 * 1024 * 1024};

// Answers every call with what it was called with, after a moment; a tool named `refused` is refused.
const echo: ScriptHost = async (method: PapMethod, args: Json[]): Promise<PapAnswer> => {
	await Bun.sleep(5);
	if (method === 'call' && args[1] === 'refused') {
		return Err({kind: 'forbidden', message: 'This login may not run refused with this connection.'});
	}
	return Ok(JSON.stringify({method, args}));
};

async function run(source: string, host: ScriptHost = echo, limits: ScriptLimits = LIMITS): Promise<ScriptRun> {
	const result = await runScript(source, host, limits);
	if (result.isErr()) {
		throw new Error(`The runner failed: ${result.error.kind}`);
	}
	return result.value;
}

function returned(run: ScriptRun): Json {
	if (run.outcome.type !== 'returned') {
		throw new Error(`The script did not return: ${JSON.stringify(run.outcome)}`);
	}
	return JSON.parse(run.outcome.json);
}

function threw(run: ScriptRun) {
	if (run.outcome.type !== 'threw') {
		throw new Error(`The script did not throw: ${JSON.stringify(run.outcome)}`);
	}
	return run.outcome.error;
}

describe('runScript', () => {
	test('runs TypeScript, its calls at once, and gives back what it returned and logged', async () => {
		const result = await run(`
			const tools: string[] = ['a', 'b', 'c'];
			const answers = await Promise.all(tools.map((tool) => pap.call('connection', tool, {limit: 1})));
			console.log('answered', answers.length, {first: answers[0].args[1]});
			return answers.map((answer) => answer.args[1]);
		`);
		expect(returned(result)).toEqual(['a', 'b', 'c']);
		expect(result.logs).toEqual(['answered 3 {"first":"a"}']);
		expect(result.calls).toBe(3);
	});

	test('gives every pap function to the host by name, with its arguments', async () => {
		const result = await run(`return [await pap.startTask({title: 't', goal: 'g'}), await pap.connections(), await pap.tools('c'), await pap.finishTask({}), await pap.feedback({message: 'm'})];`);
		expect(returned(result)).toEqual([
			{method: 'startTask', args: [{title: 't', goal: 'g'}]},
			{method: 'connections', args: []},
			{method: 'tools', args: ['c']},
			{method: 'finishTask', args: [{}]},
			{method: 'feedback', args: [{message: 'm'}]},
		]);
	});

	test('gives nothing for undefined', async () => {
		expect(returned(await run('return undefined;'))).toBeNull();
	});

	test('throws a refused call as an error the script can catch, with its kind', async () => {
		const result = await run(`try { await pap.call('c', 'refused', {}); } catch (error) { return [error.name, error.kind, error.message]; }`);
		expect(returned(result)).toEqual(['PapError', 'forbidden', 'This login may not run refused with this connection.']);
	});

	test('says where an error the script did not catch was thrown, by the line it wrote', async () => {
		const error = threw(await run(`const x: number = 1;\n\nawait pap.call('c', 'refused', {});`));
		expect(error.name).toBe('PapError');
		expect(error.stack).toContain('script.js:3:');
	});

	test('refuses a script that does not parse', async () => {
		expect(threw(await run('return (;')).name).toBe('SyntaxError');
	});

	test('refuses arguments JSON cannot hold', async () => {
		const result = await run(`const a = {}; a.self = a; return await pap.call('c', 't', a);`);
		expect(threw(result).message).toContain('JSON');
		expect(result.calls).toBe(0);
	});

	test('gives the script none of the runner’s own globals', async () => {
		const result = await run(`return [typeof process, typeof require, typeof fetch, typeof Bun, typeof setTimeout, await import('fs').then(() => 'imported', () => 'refused')];`);
		expect(returned(result)).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'refused']);
	});

	test('stops code that runs too long', async () => {
		expect(threw(await run('while (true) {}')).message).toBe('interrupted');
	});

	test('counts only the script’s own code against its time, not waiting on calls', async () => {
		const slow: ScriptHost = async () => {
			await Bun.sleep(300);
			return Ok('1');
		};
		const result = await run(`let sum = 0; for (let i = 0; i < 3; i++) sum += await pap.call('c', 't', {}); return sum;`, slow);
		expect(returned(result)).toBe(3);
	});

	test('stops a script that takes too much memory', async () => {
		const error = threw(await run(`const kept = []; while (true) kept.push(new Array(100000).fill(1));`));
		expect(error.message).toContain('out of memory');
	});

	test('stops runaway recursion, telling of the first few calls', async () => {
		const error = threw(await run('const f = (n) => f(n + 1) + 1; return f(0);'));
		expect(error.message).toBe('stack overflow');
		expect(error.stack?.split('\n').length).toBeLessThanOrEqual(11);
	});

	test('stops a run past its wall clock, as when a call never answers', async () => {
		const never: ScriptHost = () => new Promise(() => {});
		const result = await run(`await pap.call('c', 't', {});`, never, {...LIMITS, wallMs: 300});
		expect(result.outcome).toEqual({type: 'stopped', reason: 'timeout'});
	});

	test('stops a script that writes too much', async () => {
		const result = await run(`while (true) console.log('x'.repeat(100000));`, echo, {...LIMITS, maxOutputBytes: 1_000_000});
		expect(result.outcome).toEqual({type: 'stopped', reason: 'output'});
	});

	test('refuses calls past the limit', async () => {
		const result = await run(`let refused = 0; for (let i = 0; i < 7; i++) { try { await pap.call('c', 't', {}); } catch (error) { refused++; } } return refused;`, echo, {...LIMITS, maxCalls: 5});
		expect(returned(result)).toBe(2);
	});

	test('answers no more calls at once than the limit', async () => {
		let running = 0;
		let most = 0;
		const counting: ScriptHost = async () => {
			running++;
			most = Math.max(most, running);
			await Bun.sleep(10);
			running--;
			return Ok('1');
		};
		const result = await run(`return (await Promise.all(Array.from({length: 20}, () => pap.call('c', 't', {})))).length;`, counting, {...LIMITS, maxConcurrentCalls: 3});
		expect(returned(result)).toBe(20);
		expect(most).toBe(3);
	});
});
