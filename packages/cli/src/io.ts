import type {Result} from 'ts-results-es';

/**
 * What a command works with, so the commands never touch the process: the environment, stdin,
 * stdout and stderr, fetch, for `pap git` and `pap gh`, running another program, files, and an
 * HTTP server on a unix socket, and for `pap files`, reading and writing the files it moves. node-io.ts gives Node's; the tests give their own. Also the exit
 * codes, and a failure: the code to exit with and one line saying what to do.
 */

export type Json = string | number | boolean | null | Json[] | {[key: string]: Json};

export type JsonObject = {[key: string]: Json};

export type Env = Record<string, string | undefined>;

/** Answers a request the server was sent. */
export type Handler = (request: Request) => Promise<Response>;

export type Io = {
	/** pap's environment, which a program it runs is given as it is, with what pap adds. */
	env: Env;
	readStdin: () => Promise<string>;
	out: (text: string) => void;
	err: (text: string) => void;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** The Node binary running pap, and pap's own file, both absolute. */
	self: {node: string; script: string};
	/** Whether `path` is a file that can be run. */
	isExecutable: (path: string) => boolean;
	/**
	 * Runs a program with pap's stdin, stdout and stderr, passing on the signals pap is sent while it
	 * runs, and answers its exit code, or 128 and the signal's number where a signal ended it.
	 */
	spawn: (file: string, args: string[], env: Env) => Promise<Result<number, Error>>;
	/** A new directory of pap's own, with a path short enough for a unix socket in it. */
	makeTempDir: () => Promise<Result<string, Error>>;
	writeFile: (path: string, text: string, mode: number) => Promise<Result<void, Error>>;
	/** Removes a directory and everything in it. */
	removeDir: (path: string) => Promise<void>;
	/** A path as it was given, made absolute against where pap was run. */
	absolutePath: (path: string) => string;
	/** Whether `path` is a directory that is there. */
	isDirectory: (path: string) => boolean;
	/** A file's bytes, whole. */
	readBytes: (path: string) => Promise<Result<Uint8Array<ArrayBuffer>, Error>>;
	/** A file's text; null where there is no such file. */
	readText: (path: string) => Promise<Result<string | null, Error>>;
	/** Writes what `body` gives to the file at `path`, as it comes, making the directories on the way; how many bytes it wrote. */
	saveStream: (path: string, body: ReadableStream<Uint8Array>) => Promise<Result<number, Error>>;
	/** An HTTP server listening on the unix socket `path`, until the close it answers is called. */
	serve: (path: string, handler: Handler) => Promise<Result<() => Promise<void>, Error>>;
};

export const EXIT = {ok: 0, failed: 1, usage: 2, refused: 3} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Failure = {exit: ExitCode; message: string};

export function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function failed(message: string): Failure {
	return {exit: EXIT.failed, message};
}

export function usage(message: string): Failure {
	return {exit: EXIT.usage, message};
}

export function refused(message: string): Failure {
	return {exit: EXIT.refused, message};
}
