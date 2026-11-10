/**
 * What a command works with, so the commands never touch the process: the environment, stdin,
 * stdout and stderr, and fetch. main.ts gives Node's; the tests give their own. Also the exit
 * codes, and a failure: the code to exit with and one line saying what to do.
 */

export type Json = string | number | boolean | null | Json[] | {[key: string]: Json};

export type JsonObject = {[key: string]: Json};

export type Io = {
	env: Record<string, string | undefined>;
	readStdin: () => Promise<string>;
	out: (text: string) => void;
	err: (text: string) => void;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
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
