import type {Result} from 'ts-results-es';

import {Do} from '@proxy/utils';

import {getMe, getTools, login, logout, parseOrigin, runTool} from './api';
import {parseInvocation, USAGE, type Command, type JsonValue} from './args';
import type {CliError} from './cli-error';
import {formatMe, formatToolResult, formatTools} from './output';
import {readSession, removeSession, requireLive, writeSession} from './session';

/** What a command reads from and writes to, and where it keeps the session: the terminal, or a test's. */
export type Io = {
	out: (text: string) => void;
	err: (text: string) => void;
	// Asks for the password without showing it.
	readPassword: (prompt: string) => Promise<Result<string, CliError>>;
	// Everything piped in.
	readStdin: () => Promise<Result<string, CliError>>;
	configDir: string;
	now: () => Date;
};

// What a command prints: the server's JSON, or the same for reading.
type Printed = {raw: JsonValue; text: string};

function json(raw: JsonValue): string {
	return JSON.stringify(raw, null, 2);
}

// The password piped in, without the newline `echo` ends it with.
function password(
	command: Extract<Command, {name: 'login'}>,
	io: Io,
): Promise<Result<string, CliError>> {
	if (command.passwordStdin) {
		return io.readStdin().then((read) => read.map((text) => text.replace(/\r?\n$/, '')));
	}
	return io.readPassword('Password: ');
}

function run(command: Command, io: Io): Promise<Result<Printed, CliError>> {
	return Do(async ($): Promise<Printed> => {
		if (command.name === 'help') {
			return {raw: {usage: USAGE}, text: USAGE};
		}
		if (command.name === 'login') {
			// Checked before the password is asked for.
			const origin = $(parseOrigin(command.url));
			const session = $(await login(origin, command.username, $(await password(command, io))));
			$(await writeSession(io.configDir, session));
			const me = $(await getMe(session));
			return {raw: me.raw, text: formatMe(me.value)};
		}
		if (command.name === 'logout') {
			const session = $(await readSession(io.configDir));
			if (!session) {
				return {raw: {signedIn: false}, text: 'Not signed in.'};
			}
			// The session is forgotten here even when the server can't be told, and that is said.
			const ended = await logout(session);
			$(await removeSession(io.configDir));
			$(ended);
			return {raw: {signedIn: false}, text: 'Signed out.'};
		}

		const session = $(requireLive($(await readSession(io.configDir)), io.now()));
		if (command.name === 'connections') {
			const me = $(await getMe(session));
			return {raw: me.raw, text: formatMe(me.value)};
		}
		if (command.name === 'tools') {
			const tools = $(await getTools(session, command.connectionId));
			return {raw: tools.raw, text: formatTools(tools.value.tools)};
		}
		const result = $(await runTool(session, command.connectionId, command.tool, command.params));
		return {raw: result.raw, text: formatToolResult(result.value)};
	});
}

/** Runs the command the arguments name, and the exit code it ends with. */
export async function main(argv: string[], io: Io): Promise<number> {
	const invocation = parseInvocation(argv);
	if (invocation.isErr()) {
		io.err(`${invocation.error.message}\n`);
		return invocation.error.exitCode;
	}

	const {command, json: asJson} = invocation.value;
	const result = await run(command, io);
	if (result.isErr()) {
		io.err(
			asJson ? `${json({error: result.error.message})}\n` : `proxy: ${result.error.message}\n`,
		);
		return result.error.exitCode;
	}
	io.out(`${asJson ? json(result.value.raw) : result.value.text}\n`);
	return 0;
}
