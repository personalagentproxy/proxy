import {writeSync} from 'node:fs';

import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime} from 'quickjs-emscripten-core';

import {PAP_METHODS} from '@proxy/contracts/cli';

import {readLines} from './lines';
import {type AnswerMessage, apiMessageSchema, type RunnerMessage, type ScriptError, type StartMessage} from './protocol';

/**
 * A script's runner: a process of its own, started by the api with nothing in its environment
 * (run-script.ts), which loads QuickJS, runs one script and exits. The script reaches nothing but
 * what is put in its global scope here: `pap`, whose every call is sent to the api to answer, and
 * `console`, whose lines are sent too. QuickJS is WebAssembly, so a script that broke the
 * interpreter would still be in its memory, and this process holds no secret to find beyond it.
 * The limits are kept here as well as the api can't: memory, stack depth, and how long the
 * script's own code may run, time waiting on the api not counted; the api keeps the wall clock.
 */

type Outcome = Extract<RunnerMessage, {type: 'done'}>['outcome'];

// Written at once, so nothing is left unsent when the runner exits.
function send(message: RunnerMessage): void {
	writeSync(1, `${JSON.stringify(message)}\n`);
}

// The script's own built-ins it might replace, taken before it runs, so what the runner does with
// them is never the script's code.
type Builtins = {stringify: QuickJSHandle; parse: QuickJSHandle; toText: QuickJSHandle};

function takeBuiltins(context: QuickJSContext): Builtins {
	const json = context.getProp(context.global, 'JSON');
	const builtins = {stringify: context.getProp(json, 'stringify'), parse: context.getProp(json, 'parse'), toText: context.getProp(context.global, 'String')};
	json.dispose();
	return builtins;
}

// A value of the script's as JSON text, or null for one JSON can't hold, as a cycle.
function toJson(context: QuickJSContext, builtins: Builtins, value: QuickJSHandle): string | null {
	const result = context.callFunction(builtins.stringify, context.undefined, value);
	if (result.error) {
		result.error.dispose();
		return null;
	}
	const text = context.typeof(result.value) === 'string' ? context.getString(result.value) : null;
	result.value.dispose();
	return text;
}

function toText(context: QuickJSContext, builtins: Builtins, value: QuickJSHandle): string {
	if (context.typeof(value) === 'string') {
		return context.getString(value);
	}
	const result = context.callFunction(builtins.toText, context.undefined, value);
	if (result.error) {
		result.error.dispose();
		return '[a value that can’t be shown]';
	}
	const text = context.getString(result.value);
	result.value.dispose();
	return text;
}

// A value logged: text as it is, anything else as JSON where it can be, as a console shows it.
function toLogText(context: QuickJSContext, builtins: Builtins, value: QuickJSHandle): string {
	if (context.typeof(value) === 'string') {
		return context.getString(value);
	}
	return toJson(context, builtins, value) ?? toText(context, builtins, value);
}

function stringProp(context: QuickJSContext, value: QuickJSHandle, key: string): string | undefined {
	const prop = context.getProp(value, key);
	const text = context.typeof(prop) === 'string' ? context.getString(prop) : undefined;
	prop.dispose();
	return text;
}

// What the script threw: an Error's name, message and stack, or anything else as text.
function toError(context: QuickJSContext, builtins: Builtins, thrown: QuickJSHandle): ScriptError {
	if (context.typeof(thrown) !== 'object') {
		return {name: 'Error', message: toText(context, builtins, thrown)};
	}
	const message = stringProp(context, thrown, 'message');
	if (message === undefined) {
		return {name: 'Error', message: toJson(context, builtins, thrown) ?? toText(context, builtins, thrown)};
	}
	return {name: stringProp(context, thrown, 'name') ?? 'Error', message, stack: stringProp(context, thrown, 'stack')};
}

// Runs what the script does in QuickJS, counting the time against its budget: the interrupt
// handler stops it once its own code has run for `cpuMs` in all, and counts the times it did.
function cpuClock(runtime: QuickJSRuntime, cpuMs: number) {
	let used = 0;
	let enteredAt: number | null = null;
	let interrupts = 0;
	runtime.setInterruptHandler(() => {
		const over = enteredAt !== null && used + (performance.now() - enteredAt) > cpuMs;
		if (over) {
			interrupts++;
		}
		return over;
	});
	const inVm = <T>(work: () => T): T => {
		enteredAt = performance.now();
		const result = work();
		used += performance.now() - enteredAt;
		enteredAt = null;
		return result;
	};
	return {inVm, interrupts: () => interrupts};
}

async function run(start: StartMessage, answers: AsyncGenerator<string>): Promise<void> {
	const module = await quickjs;
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(start.memoryBytes);
	runtime.setMaxStackSize(start.stackBytes);
	const clock = cpuClock(runtime, start.cpuMs);
	const inVm = clock.inVm;
	const context = runtime.newContext();
	const builtins = takeBuiltins(context);

	const pending = new Map<number, QuickJSDeferredPromise>();
	let nextId = 0;

	const pap = context.newObject();
	for (const method of PAP_METHODS) {
		const fn = context.newFunction(method, (...args) => {
			const deferred = context.newPromise();
			const list = context.newArray();
			args.forEach((arg, index) => context.setProp(list, index, arg));
			const json = toJson(context, builtins, list);
			list.dispose();
			if (json === null) {
				const error = context.newError({name: 'TypeError', message: `pap.${method} takes values JSON can hold: no functions or cycles.`});
				deferred.reject(error);
				error.dispose();
				return deferred.handle;
			}
			const id = nextId++;
			pending.set(id, deferred);
			send({type: 'call', id, method, argsJson: json});
			return deferred.handle;
		});
		context.setProp(pap, method, fn);
		fn.dispose();
	}
	context.setProp(context.global, 'pap', pap);
	pap.dispose();

	const consoleObject = context.newObject();
	const log = context.newFunction('log', (...args) => {
		send({type: 'log', text: args.map((arg) => toLogText(context, builtins, arg)).join(' ')});
	});
	for (const name of ['log', 'info', 'warn', 'error']) {
		context.setProp(consoleObject, name, log);
	}
	log.dispose();
	context.setProp(context.global, 'console', consoleObject);
	consoleObject.dispose();

	// What the script returned or threw, made into text in QuickJS on the script's own time: its
	// toJSON, getters and toString are its code, and stopped as the rest of it is once its time is up.
	const finish = (outcomeOf: () => Outcome): never => {
		const interrupted = clock.interrupts();
		const outcome = inVm(outcomeOf);
		send({type: 'done', outcome: clock.interrupts() > interrupted ? {ok: false, error: {name: 'InternalError', message: 'interrupted'}} : outcome});
		process.exit(0);
	};
	const threw = (thrown: QuickJSHandle) => finish(() => ({ok: false, error: toError(context, builtins, thrown)}));

	// What a job left over from an answer threw out of the script, as an interrupt does; an
	// error thrown in the script's own code rejects its promise instead.
	const pump = () => {
		const ran = inVm(() => runtime.executePendingJobs());
		if (ran.error) {
			threw(ran.error);
		}
	};

	const evaluated = inVm(() => context.evalCode(start.code, 'script.js', {type: 'global'}));
	if (evaluated.error) {
		threw(evaluated.error);
		return;
	}
	void context.resolvePromise(evaluated.value).then((settled) => {
		if (settled.error) {
			threw(settled.error);
			return;
		}
		finish(() => ({ok: true, json: toJson(context, builtins, settled.value) ?? 'null'}));
	});
	evaluated.value.dispose();
	pump();

	for await (const line of answers) {
		const parsed = apiMessageSchema.safeParse(JSON.parse(line));
		if (!parsed.success || parsed.data.type !== 'answer') {
			continue;
		}
		settle(context, builtins, pending, parsed.data);
		pump();
	}
}

function settle(context: QuickJSContext, builtins: Builtins, pending: Map<number, QuickJSDeferredPromise>, message: AnswerMessage): void {
	const deferred = pending.get(message.id);
	if (!deferred) {
		return;
	}
	pending.delete(message.id);
	if (!message.answer.ok) {
		const error = context.newError({name: 'PapError', message: message.answer.message});
		const kind = context.newString(message.answer.kind);
		context.setProp(error, 'kind', kind);
		kind.dispose();
		deferred.reject(error);
		error.dispose();
		return;
	}
	const text = context.newString(message.answer.json);
	const value = context.callFunction(builtins.parse, context.undefined, text);
	text.dispose();
	if (value.error) {
		deferred.reject(value.error);
		value.error.dispose();
		return;
	}
	deferred.resolve(value.value);
	value.value.dispose();
}

// Loaded while the api has nothing for this runner yet, so a script starts on one ready.
const quickjs = newQuickJSWASMModuleFromVariant(variant);
await quickjs;
send({type: 'ready'});

const input = readLines(Bun.stdin.stream());
const first = await input.next();
const start = first.done ? null : apiMessageSchema.safeParse(JSON.parse(first.value));
if (!start?.success || start.data.type !== 'start') {
	process.exit(1);
}
await run(start.data, input);
