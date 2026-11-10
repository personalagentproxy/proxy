import {nodeIo} from './node-io';
import {run} from './run';

/**
 * The `pap` binary's entry: the bundle build.ts makes from this, which runs under plain Node 20 or
 * newer, given Node's process as its io. `PAP_VERSION` is put in by the build; from source, `dev`.
 */

declare const PAP_VERSION: string | undefined;

void run(
	process.argv.slice(2),
	nodeIo(),
	typeof PAP_VERSION === 'string' ? PAP_VERSION : 'dev',
).then((code) => {
	process.exitCode = code;
});
