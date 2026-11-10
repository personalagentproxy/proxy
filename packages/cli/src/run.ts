import {COMMANDS} from './commands';
import {EXIT, type Io} from './io';
import {CONNECTION_ENV} from './programs';

/**
 * `pap`: a sandbox command's way to the agent's connections, run with `pap: true` on
 * `sandbox_exec`, which gives it `PAP_URL` and `PAP_TOKEN`. Picks the command by its first
 * argument and hands it the rest, untouched; `--help` and `--version` are answered here, and
 * `--connection <id>` before `git` or `gh`, which names the GitHub connection in
 * `PAP_GITHUB_CONNECTION`, there for the programs they run too, as gh's git.
 */

const CONNECTION_FLAG = '--connection';

// Commands `--connection` goes before.
const GITHUB_COMMANDS = new Set(['git', 'gh']);

// `--connection <id>` or `--connection=<id>` first: the id, and the arguments after it.
function leadingConnection(args: string[]): {connection: string | undefined; rest: string[]} {
	const [first = ''] = args;
	if (first === CONNECTION_FLAG) {
		return {connection: args[1] ?? '', rest: args.slice(2)};
	}
	if (first.startsWith(`${CONNECTION_FLAG}=`)) {
		return {connection: first.slice(CONNECTION_FLAG.length + 1), rest: args.slice(1)};
	}
	return {connection: undefined, rest: args};
}

function help(): string {
	const commands = Object.values(COMMANDS);
	const width = Math.max(...commands.map((command) => command.usage.length)) + 2;
	const lines = commands.map((command) => `  ${command.usage.padEnd(width)}${command.summary}`);
	return `pap: your connections, from a sandbox_exec command run with pap: true.

${lines.join('\n')}

stdout: the result as JSON. stderr: what went wrong, one line. git and gh print and exit as theirs.
Exit: 0 done, 1 call failed, 2 bad usage, 3 no token or token refused.
pap <command> --help for more; pap git and pap gh without arguments.
`;
}

export async function run(args: string[], io: Io, version: string): Promise<number> {
	const {connection, rest: afterFlag} = leadingConnection(args);
	const [name, ...rest] = afterFlag;
	if (connection !== undefined) {
		if (connection.trim() === '' || name === undefined || !GITHUB_COMMANDS.has(name)) {
			io.err('pap: --connection <id> goes before git or gh: pap --connection <id> git <args>\n');
			return EXIT.usage;
		}
		io.env[CONNECTION_ENV] = connection.trim();
	}
	if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
		io.out(help());
		return EXIT.ok;
	}
	if (name === '-v' || name === '--version') {
		io.out(`${version}\n`);
		return EXIT.ok;
	}
	const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
	if (command === undefined) {
		io.err(`pap: no command ${name}. See pap --help.\n`);
		return EXIT.usage;
	}
	return command.main(rest, io);
}
