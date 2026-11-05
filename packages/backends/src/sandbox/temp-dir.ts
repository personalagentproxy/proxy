import {spawn} from 'node:child_process';
import {mkdir, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import type {SandboxBackend, SandboxCommand, SandboxOutput, SandboxRef} from './backend';

/**
 * The backend the tests run against, and a developer's own machine with `SANDBOX_BACKEND=dev`:
 * a directory under `root` for each sandbox, commands run in it by this machine's own shell, as
 * this process, with nothing but a path and a locale in their environment. Nothing is isolated:
 * a command reaches the whole machine, so this is never a backend for people, only what the
 * conformance tests, the tests of what uses sandboxes, and a developer trying things run on. A
 * ref is the sandbox's directory, the same asleep as running; sleeping ends what the sandbox was
 * running, as it does on any backend.
 */

// How much of what a command wrote is kept.
const MAX_OUTPUT_BYTES = 1_000_000;

// How long after the timeout the shell is given to end before being killed outright.
const KILL_AFTER_MS = 2_000;

function notFound(ref: SandboxRef): ApiError {
	return ApiErr.notFound('sandbox', ref);
}

// Ends every process in the group, as a command's shell and what it left running are one: by the
// system's own kill, which takes a group the same way everywhere, where the runtime's doesn't.
function killGroup(group: number, signal: 'TERM' | 'KILL'): Promise<void> {
	return new Promise((done) => {
		const kill = spawn('/bin/sh', ['-c', 'kill -s "$1" -- "-$2" 2>/dev/null', '_', signal, String(group)], {stdio: 'ignore'});
		kill.on('error', () => done());
		kill.on('close', () => done());
	});
}

// Runs the command in the directory, in a process group of its own, which `groups` notes so the
// sandbox's sleep can end what the command left running; killed as a whole on timeout. What a
// command leaves running outlives it here, which the contract doesn't promise.
function run(directory: string, command: SandboxCommand, groups: Set<number>): Promise<SandboxOutput> {
	return new Promise((resolveOutput) => {
		const child = spawn('/bin/sh', ['-c', command.command], {
			cwd: command.cwd === undefined ? directory : resolve(directory, command.cwd),
			env: {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8'},
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const group = child.pid;
		if (group !== undefined) {
			groups.add(group);
		}
		const chunks = {stdout: [] as Buffer[], stderr: [] as Buffer[]};
		const sizes = {stdout: 0, stderr: 0};
		const keep = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
			if (sizes[stream] >= MAX_OUTPUT_BYTES) {
				return;
			}
			chunks[stream].push(chunk.subarray(0, MAX_OUTPUT_BYTES - sizes[stream]));
			sizes[stream] += chunk.length;
		};
		child.stdout.on('data', (chunk: Buffer) => keep('stdout', chunk));
		child.stderr.on('data', (chunk: Buffer) => keep('stderr', chunk));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (group === undefined) {
				return;
			}
			void killGroup(group, 'TERM');
			setTimeout(() => void killGroup(group, 'KILL'), KILL_AFTER_MS).unref();
		}, command.timeoutMs);
		child.on('error', () => {
			clearTimeout(timer);
			resolveOutput({stdout: '', stderr: 'The shell could not be started.', exitCode: null, timedOut: false});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolveOutput({stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString(), exitCode: timedOut ? null : code, timedOut});
		});
		child.stdin.on('error', () => undefined);
		child.stdin.end(command.stdin ?? '');
	});
}

/** A backend with its sandboxes under `root`, a directory of this machine, made as the first sandbox is. */
export function tempDirSandboxBackend(root: string): SandboxBackend {
	const base = resolve(root);
	// The process groups each sandbox's commands ran in, by its directory, until it sleeps.
	const running = new Map<string, Set<number>>();

	// The directory of a sandbox the backend made, or not found.
	const requireDirectory = (ref: SandboxRef): Promise<Result<string, ApiError>> =>
		Do(async ($) => {
			const directory = resolve(ref);
			const found = directory.startsWith(`${base}/`) ? await Result.wrapAsync(() => stat(directory)) : null;
			if (!found?.isOk() || !found.value.isDirectory()) {
				return $(Err(notFound(ref)));
			}
			return directory;
		});

	const endRunning = async (directory: string): Promise<void> => {
		await Promise.all([...(running.get(directory) ?? [])].map((group) => killGroup(group, 'KILL')));
		running.delete(directory);
	};

	return {
		id: 'temp-dir',
		create: ({tenant, sandboxId}) =>
			Do(async ($) => {
				const directory = join(base, tenant, sandboxId);
				$((await Result.wrapAsync(() => mkdir(directory, {recursive: true}))).mapErr(ApiErr.internalError));
				return directory;
			}),
		exec: (ref, command) =>
			Do(async ($) => {
				const directory = $(await requireDirectory(ref));
				const groups = running.get(directory) ?? new Set<number>();
				running.set(directory, groups);
				return await run(directory, command, groups);
			}),
		sleep: (ref) =>
			Do(async ($) => {
				const directory = $(await requireDirectory(ref));
				await endRunning(directory);
				return directory;
			}),
		wake: requireDirectory,
		destroy: (ref) =>
			Do(async ($) => {
				const directory = $(await requireDirectory(ref));
				await endRunning(directory);
				$((await Result.wrapAsync(() => rm(directory, {recursive: true, force: true}))).mapErr(ApiErr.internalError));
			}),
	};
}
