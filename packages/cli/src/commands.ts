import {Err, Ok, Result} from 'ts-results-es';

import {Do} from '@proxy/utils/do';

import {type FlagSpec, type Parsed, parseArgs} from './args';
import {clientFrom} from './client';
import {FILES, FILES_HELP, listFiles, LS, PULL, pullFile, PUSH, pushFile} from './files';
import {ghMain} from './gh';
import {gitMain} from './git';
import {EXIT, type Failure, type Io, isObject, type Json, type JsonObject, usage} from './io';
import {callAllPages, MAX_PAGES} from './pages';

/**
 * pap's commands. A command is its line in `pap --help` and `main`, which is given its arguments
 * as they came and answers with the exit code, so `pap git` and `pap gh` (git.ts, gh.ts) hand
 * theirs to the program they run, and its exit code back. Those that call a `pap` function are
 * made by `jsonCommand`: their flags parsed, their `--help`, the result printed as JSON on stdout,
 * or one line on stderr and the failure's exit code.
 */

export type Command = {
	usage: string;
	summary: string;
	main: (args: string[], io: Io) => Promise<number>;
};

type JsonCommandSpec = {
	usage: string;
	summary: string;
	help: string;
	flags: FlagSpec;
	run: (parsed: Parsed, io: Io) => Promise<Result<Json, Failure>>;
};

/** Prints the result as JSON, or what went wrong, and gives the exit code. */
export function finish(io: Io, result: Result<Json, Failure>): number {
	if (result.isErr()) {
		io.err(`pap: ${result.error.message}\n`);
		return result.error.exit;
	}
	io.out(`${JSON.stringify(result.value)}\n`);
	return EXIT.ok;
}

function jsonCommand(name: string, spec: JsonCommandSpec): Command {
	return {
		usage: spec.usage,
		summary: spec.summary,
		main: async (args, io) => {
			const parsed = parseArgs(args, spec.flags, name);
			if (parsed.isOk() && parsed.value.help) {
				io.out(spec.help);
				return EXIT.ok;
			}
			return finish(io, parsed.isErr() ? parsed : await spec.run(parsed.value, io));
		},
	};
}

// The positionals a command takes, or usage naming them.
function positionals(
	parsed: Parsed,
	min: number,
	max: number,
	line: string,
): Result<string[], Failure> {
	const count = parsed.positionals.length;
	if (count < min || count > max) {
		return Err(usage(`Usage: ${line}`));
	}
	return Ok(parsed.positionals);
}

// A tool's params: a JSON object given, read from stdin for `-`, or none.
async function readParams(given: string | undefined, io: Io): Promise<Result<JsonObject, Failure>> {
	if (given === undefined) {
		return Ok({});
	}
	const text = given === '-' ? await io.readStdin() : given;
	const value = Result.wrap((): Json => JSON.parse(text)).unwrapOr(undefined);
	if (!isObject(value)) {
		return Err(
			usage(
				`Params must be a JSON object, such as '{"search":"invoice"}'${given === '-' ? ' on stdin' : ''}.`,
			),
		);
	}
	return Ok(value);
}

// `pap files`' own commands, each answered as any command that calls the api is.
const FILES_COMMANDS: Record<string, Command> = {
	ls: jsonCommand('files ls', {
		usage: LS,
		summary: 'what a folder holds',
		help: FILES_HELP,
		flags: {},
		run: listFiles,
	}),
	pull: jsonCommand('files pull', {
		usage: PULL,
		summary: 'a file into the sandbox',
		help: FILES_HELP,
		flags: {id: 'value', version: 'value'},
		run: pullFile,
	}),
	push: jsonCommand('files push', {
		usage: PUSH,
		summary: 'a file to the drive',
		help: FILES_HELP,
		flags: {force: 'switch'},
		run: pushFile,
	}),
};

// `pap files <ls|pull|push>`: the command named, given the rest; without one, or with one it
// hasn't, what there is.
async function filesMain(args: string[], io: Io): Promise<number> {
	const [name, ...rest] = args;
	const command =
		name !== undefined && Object.hasOwn(FILES_COMMANDS, name) ? FILES_COMMANDS[name] : undefined;
	if (command !== undefined) {
		return command.main(rest, io);
	}
	if (name === undefined || name === '-h' || name === '--help') {
		io.out(FILES_HELP);
		return EXIT.ok;
	}
	io.err(`pap: no command files ${name}. See pap files --help.\n`);
	return EXIT.usage;
}

const CONNECTIONS = 'pap connections';
const TOOLS = 'pap tools <connection>';
const CALL = 'pap call <connection> <tool> [json|-] [--all]';
const FEEDBACK = 'pap feedback <message> [--connection <id>] [--tool <name>]';

export const COMMANDS: Record<string, Command> = {
	connections: jsonCommand('connections', {
		usage: CONNECTIONS,
		summary: 'connections you can use',
		help: `${CONNECTIONS}\nThe connections you can use, with their ids.\n`,
		flags: {},
		run: (parsed, io) =>
			Do(async ($) => {
				$(positionals(parsed, 0, 0, CONNECTIONS));
				return $(await $(clientFrom(io)).call('connections', []));
			}),
	}),
	tools: jsonCommand('tools', {
		usage: TOOLS,
		summary: "a connection's tools and their params",
		help: `${TOOLS}\nA connection's tools, with the params each takes.\n`,
		flags: {},
		run: (parsed, io) =>
			Do(async ($) => {
				const [connection = ''] = $(positionals(parsed, 1, 1, TOOLS));
				return $(await $(clientFrom(io)).call('tools', [connection]));
			}),
	}),
	call: jsonCommand('call', {
		usage: CALL,
		summary: 'run a tool',
		help: `${CALL}
Runs a tool. Params: a JSON object, - to read it from stdin, or none.
--all  for a list tool: follows nextPage, printing every page's records as one list (at most ${MAX_PAGES} pages).
Example: pap call <connection> entries_list '{"search":"invoice"}' | jq '.records[].id'
`,
		flags: {all: 'switch'},
		run: (parsed, io) =>
			Do(async ($) => {
				const [connection = '', tool = '', given] = $(positionals(parsed, 2, 3, CALL));
				const params = $(await readParams(given, io));
				const client = $(clientFrom(io));
				const call = (with_: JsonObject) => client.call('call', [connection, tool, with_]);
				if (parsed.switches.has('all')) {
					return $(await callAllPages(io, call, params));
				}
				return $(await call(params));
			}),
	}),
	feedback: jsonCommand('feedback', {
		usage: FEEDBACK,
		summary: 'tell the makers what was missing or wrong',
		help: `${FEEDBACK}\nTells the makers of Personal Agent Proxy what was missing or wrong.\n`,
		flags: {connection: 'value', tool: 'value'},
		run: (parsed, io) =>
			Do(async ($) => {
				if (parsed.positionals.length === 0) {
					return $(Err(usage(`Usage: ${FEEDBACK}`)));
				}
				const {connection, tool} = parsed.values;
				const body = {
					message: parsed.positionals.join(' '),
					...(connection ? {connection} : {}),
					...(tool ? {tool} : {}),
				};
				return $(await $(clientFrom(io)).call('feedback', [body]));
			}),
	}),
	files: {
		usage: FILES,
		summary: 'a drive’s files by path: list a folder, pull a file in, push one back',
		main: filesMain,
	},
	git: {
		usage: 'pap git <args>',
		summary: 'git, signed in to GitHub as your GitHub connection’s account',
		main: gitMain,
	},
	gh: {
		usage: 'pap gh <args>',
		summary: 'GitHub’s gh, signed in the same way',
		main: ghMain,
	},
};
