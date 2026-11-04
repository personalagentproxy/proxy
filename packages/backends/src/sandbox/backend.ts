import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

/**
 * What a sandbox is to the api: a computer an agent asked for, with a disk that is kept while it
 * is asleep, run by a backend. The api owns each sandbox's row and its state (native/sandbox, to
 * come); a backend owns the machine, and is asked for nothing but these five things. A ref is the
 * backend's own name for the sandbox as it is now, opaque to the api, which keeps the latest: a
 * backend that stops a machine and keeps its disk may hand the same ref back from sleep and wake;
 * one that snapshots the disk to storage and restores it hands a new one each time. The console
 * is the whole surface: a command, what to feed it on stdin, what it wrote and how it ended.
 * Every backend passes the same tests (conformance.ts), the one the tests use among them
 * (temp-dir.ts).
 */

export type SandboxRef = string;

/**
 * A command for the sandbox's shell, run in `cwd` or the sandbox's home, fed `stdin` where given
 * and nothing otherwise, and stopped after `timeoutMs`. A command is one sitting: what it leaves
 * running in the background may not outlive it, as it doesn't on every backend, so long work is
 * done within the timeout, or in parts.
 */
export type SandboxCommand = {command: string; stdin?: string; cwd?: string; timeoutMs: number};

/** What a command wrote and how it ended: `exitCode` null where it was stopped, `timedOut` whether by the timeout. */
export type SandboxOutput = {stdout: string; stderr: string; exitCode: number | null; timedOut: boolean};

export type SandboxBackend = {
	/** Which backend it is, kept with each sandbox, so one backend is never asked for another's. */
	id: string;
	/** A new sandbox, running, for a tenant, the organization, by the id the api gave the sandbox. */
	create: (sandbox: {tenant: string; sandboxId: string}) => Promise<Result<SandboxRef, ApiError>>;
	/** Runs a command in a running sandbox; conflict for one asleep, not found for a ref it doesn't know. */
	exec: (ref: SandboxRef, command: SandboxCommand) => Promise<Result<SandboxOutput, ApiError>>;
	/** Stops the sandbox's compute, keeping its disk, and gives its ref from now on. Whatever a command left running is gone. */
	sleep: (ref: SandboxRef) => Promise<Result<SandboxRef, ApiError>>;
	/** Starts an asleep sandbox again, its disk as it was, and gives its ref from now on. */
	wake: (ref: SandboxRef) => Promise<Result<SandboxRef, ApiError>>;
	/** Removes the sandbox and its disk for good, running or asleep. */
	destroy: (ref: SandboxRef) => Promise<Result<void, ApiError>>;
};
