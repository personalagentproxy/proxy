import {Err, Ok, type Result} from 'ts-results-es';

import {type Failure, usage} from './io';

/**
 * A command's own arguments, after its name: positionals, and the flags it takes, each either a
 * switch or one taking a value (`--tool x` or `--tool=x`). `--` ends the flags. A flag it doesn't
 * take is a usage error. `-h` and `--help` anywhere ask for the command's help.
 */

export type FlagSpec = Record<string, 'switch' | 'value'>;

export type Parsed = {
	positionals: string[];
	values: Record<string, string>;
	switches: Set<string>;
	help: boolean;
};

export function parseArgs(
	args: string[],
	spec: FlagSpec,
	command: string,
): Result<Parsed, Failure> {
	const parsed: Parsed = {positionals: [], values: {}, switches: new Set(), help: false};
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? '';
		if (arg === '--') {
			parsed.positionals.push(...args.slice(at + 1));
			return Ok(parsed);
		}
		if (arg === '-h' || arg === '--help') {
			parsed.help = true;
			continue;
		}
		if (!arg.startsWith('--')) {
			parsed.positionals.push(arg);
			continue;
		}
		const [name = '', inline] = arg.slice(2).split(/=(.*)/s, 2);
		const kind = spec[name];
		if (kind === undefined) {
			return Err(usage(`pap ${command} has no --${name}. See pap ${command} --help.`));
		}
		if (kind === 'switch') {
			parsed.switches.add(name);
			continue;
		}
		const value = inline ?? args[++at];
		if (value === undefined) {
			return Err(usage(`--${name} needs a value. See pap ${command} --help.`));
		}
		parsed.values[name] = value;
	}
	return Ok(parsed);
}
