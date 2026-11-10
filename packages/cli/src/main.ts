import {run} from './run';

/**
 * The `pap` binary's entry: the bundle build.ts makes from this, which runs under plain Node 20 or
 * newer, given Node's process as its io. `PAP_VERSION` is put in by the build; from source, `dev`.
 */

declare const PAP_VERSION: string | undefined;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

const io = {
	env: process.env,
	readStdin,
	out: (text: string) => void process.stdout.write(text),
	err: (text: string) => void process.stderr.write(text),
	fetch,
};

void run(process.argv.slice(2), io, typeof PAP_VERSION === 'string' ? PAP_VERSION : 'dev').then(
	(code) => {
		process.exitCode = code;
	},
);
