import {COMMANDS} from './commands';
import {EXIT, type Io} from './io';

/**
 * `pap`: a sandbox command's way to the agent's connections, run with `pap: true` on
 * `sandbox_exec`, which gives it `PAP_URL` and `PAP_TOKEN`. Picks the command by its first
 * argument and hands it the rest, untouched; `--help` and `--version` are answered here.
 */

function help(): string {
	const commands = Object.values(COMMANDS);
	const width = Math.max(...commands.map((command) => command.usage.length)) + 2;
	const lines = commands.map((command) => `  ${command.usage.padEnd(width)}${command.summary}`);
	return `pap: your connections, from a sandbox_exec command run with pap: true.

${lines.join('\n')}

stdout: the result as JSON. stderr: what went wrong, one line.
Exit: 0 done, 1 call failed, 2 bad usage, 3 no token or token refused.
pap <command> --help for more.
`;
}

export async function run(args: string[], io: Io, version: string): Promise<number> {
	const [name, ...rest] = args;
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
