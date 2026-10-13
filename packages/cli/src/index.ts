#!/usr/bin/env bun
import {Err, Ok, Result} from 'ts-results-es';

import {CliErr, type CliError} from './cli-error';
import {main} from './main';
import {configDir} from './session';

// Asks on the terminal without echoing what is typed: Enter ends it, Ctrl-C gives up, Backspace
// takes the last character back.
function readPassword(prompt: string): Promise<Result<string, CliError>> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		return Promise.resolve(
			Err(CliErr.usage('No terminal to ask for the password on: pipe it in with --password-stdin')),
		);
	}
	return new Promise((resolve) => {
		let typed = '';
		const finish = (result: Result<string, CliError>) => {
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write('\n');
			resolve(result);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					finish(Ok(typed));
					return;
				}
				if (char === '\u0003') {
					finish(Err(CliErr.failed('Cancelled')));
					return;
				}
				if (char === '\u007f' || char === '\b') {
					typed = typed.slice(0, -1);
					continue;
				}
				typed += char;
			}
		};
		process.stderr.write(prompt);
		stdin.setRawMode(true);
		stdin.setEncoding('utf8');
		stdin.on('data', onData);
		stdin.resume();
	});
}

async function readStdin(): Promise<Result<string, CliError>> {
	return (await Result.wrapAsync(() => Bun.stdin.text())).mapErr(() =>
		CliErr.failed('The password could not be read from standard input'),
	);
}

const code = await main(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	readPassword,
	readStdin,
	configDir: configDir(),
	now: () => new Date(),
});
process.exit(code);
