import {parseArgs} from 'node:util';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {CliErr, type CliError} from './cli-error';

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** A tool's params, as `--params` gives them: an object, whatever its values. */
export type Params = Record<string, JsonValue>;

export type Command =
	| {name: 'help'}
	| {name: 'login'; url: string; username: string; passwordStdin: boolean}
	| {name: 'logout'}
	| {name: 'connections'}
	| {name: 'tools'; connectionId: string}
	| {name: 'run'; connectionId: string; tool: string; params: Params};

/** A command, and whether its answer is printed as the server's JSON rather than for reading. */
export type Invocation = {command: Command; json: boolean};

export const USAGE = `proxy: an agent's way into Personal Agent Proxy from a terminal.

Usage:
  proxy login --url <APP_URL> --username <username> [--password-stdin]
  proxy logout
  proxy connections
  proxy tools <connectionId>
  proxy run <connectionId> <tool> [--params '<json>']
  proxy help

Every command takes --json, for the server's answer as JSON.

The password is asked for without showing it, or read from standard input with --password-stdin.
The session is kept in ~/.config/proxy/session.json, readable only by you.`;

// The options each command takes, beside --json and --help.
const COMMAND_OPTIONS: Record<Command['name'], string[]> = {
	help: [],
	login: ['url', 'username', 'password-stdin'],
	logout: [],
	connections: [],
	tools: [],
	run: ['params'],
};

const paramsSchema = z.record(z.string(), z.json());

function isCommandName(name: string): name is Command['name'] {
	return name in COMMAND_OPTIONS;
}

function parseParams(text: string | undefined): Result<Params, CliError> {
	if (text === undefined) {
		return Ok({});
	}
	const parsed = Result.wrap((): unknown => JSON.parse(text));
	if (parsed.isErr()) {
		return Err(CliErr.usage('--params must be JSON, such as \'{"parent":"project:inbox"}\''));
	}
	const params = paramsSchema.safeParse(parsed.value);
	if (!params.success) {
		return Err(CliErr.usage('--params must be a JSON object of the tool’s params'));
	}
	return Ok(params.data);
}

type Values = {url?: string; username?: string; 'password-stdin'?: boolean; params?: string};

function commandOf(
	name: Command['name'],
	positionals: string[],
	values: Values,
): Result<Command, CliError> {
	if (name === 'login') {
		if (!values.url || !values.username) {
			return Err(CliErr.usage('proxy login needs --url and --username'));
		}
		return Ok({
			name,
			url: values.url,
			username: values.username,
			passwordStdin: values['password-stdin'] === true,
		});
	}
	if (name === 'tools') {
		const [connectionId] = positionals;
		if (!connectionId) {
			return Err(CliErr.usage('proxy tools needs a connection id: proxy connections lists them'));
		}
		return Ok({name, connectionId});
	}
	if (name === 'run') {
		const [connectionId, tool] = positionals;
		if (!connectionId || !tool) {
			return Err(
				CliErr.usage(
					'proxy run needs a connection id and a tool: proxy tools <connectionId> lists them',
				),
			);
		}
		return parseParams(values.params).map((params) => ({name, connectionId, tool, params}));
	}
	return Ok({name});
}

// How many words a command takes after its name.
const POSITIONALS: Record<Command['name'], number> = {
	help: 0,
	login: 0,
	logout: 0,
	connections: 0,
	tools: 1,
	run: 2,
};

/** The command the arguments name, checked: its words, and only the options it takes. */
export function parseInvocation(argv: string[]): Result<Invocation, CliError> {
	const parsed = Result.wrap(() =>
		parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				json: {type: 'boolean'},
				help: {type: 'boolean', short: 'h'},
				url: {type: 'string'},
				username: {type: 'string'},
				'password-stdin': {type: 'boolean'},
				params: {type: 'string'},
			},
		}),
	);
	if (parsed.isErr()) {
		const message = parsed.error instanceof Error ? parsed.error.message : 'Unknown option';
		return Err(CliErr.usage(`${message}\n\n${USAGE}`));
	}

	const {values, positionals} = parsed.value;
	const json = values.json === true;
	const [name = 'help', ...rest] = positionals;
	if (values.help === true || name === 'help') {
		return Ok({command: {name: 'help'}, json});
	}
	if (!isCommandName(name)) {
		return Err(CliErr.usage(`proxy has no command ${name}\n\n${USAGE}`));
	}

	const given = Object.keys(values).filter((option) => option !== 'json' && option !== 'help');
	const unexpected = given.find((option) => !COMMAND_OPTIONS[name].includes(option));
	if (unexpected !== undefined) {
		return Err(CliErr.usage(`proxy ${name} takes no --${unexpected}`));
	}
	if (rest.length > POSITIONALS[name]) {
		return Err(CliErr.usage(`proxy ${name} takes no ${rest.slice(POSITIONALS[name]).join(' ')}`));
	}
	return commandOf(name, rest, values).map((command) => ({command, json}));
}
