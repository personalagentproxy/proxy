// `bun run desktop`: the desktop app on this checkout's web app. A `bun run dev` already running
// is used as it is; without one the stack is started here, and stopped again when the window
// closes. (Not a `dev` script: `bun run dev` runs every package's, and this one would start a
// second stack under the first.) The app loads the root .env's APP_URL, the one origin the api takes sign-ins from;
// DESKTOP_APP_URL names another and skips the stack.
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import {parse} from 'dotenv';
import {Result} from 'ts-results-es';

const packageDir = import.meta.dir;
const root = path.resolve(packageDir, '../..');
const START_TIMEOUT_MS = 180_000;

let stack: ChildProcess | null = null;
let electron: ChildProcess | null = null;

function fail(message: string): never {
	console.error(`[desktop] ${message}`);
	stack?.kill('SIGTERM');
	process.exit(1);
}

function configuredAppUrl(): string {
	const env = Result.wrap(() => parse(readFileSync(path.join(root, '.env'), 'utf8')));
	return env.unwrapOr<Record<string, string>>({}).APP_URL ?? 'http://localhost:5173';
}

async function isUp(url: string): Promise<boolean> {
	const response = await Result.wrapAsync(() => fetch(url, {signal: AbortSignal.timeout(2_000)}));
	return response.isOk();
}

async function waitUntilUp(url: string): Promise<void> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (!(await isUp(url))) {
		if (stack && stack.exitCode !== null) {
			fail('The dev stack stopped before the web app came up.');
		}
		if (Date.now() > deadline) {
			fail(`${url} did not come up in time.`);
		}
		await sleep(500);
	}
}

async function resolveAppUrl(): Promise<string> {
	const override = process.env.DESKTOP_APP_URL;
	if (override) {
		return override;
	}

	const appUrl = configuredAppUrl();
	if (await isUp(appUrl)) {
		console.log(`[desktop] Using the dev stack running at ${appUrl}`);
		return appUrl;
	}

	if (!existsSync(path.join(root, '.env'))) {
		fail(
			`Nothing answers at ${appUrl}, and there is no .env to start the dev stack with. Copy .env.example to .env, or run the stack elsewhere and bind its port here.`,
		);
	}

	console.log('[desktop] Starting the dev stack (bun run dev)');
	stack = spawn('node', [path.join(root, 'scripts/dev.mjs')], {cwd: root, stdio: 'inherit'});
	stack.on('exit', () => {
		// A window on a stack that is gone is no use.
		electron?.kill('SIGTERM');
	});
	await waitUntilUp(appUrl);
	return appUrl;
}

const appUrl = await resolveAppUrl();
console.log(`[desktop] App at ${appUrl}`);

const built = spawnSync('bun', ['run', 'build.ts'], {cwd: packageDir, stdio: 'inherit'});
if (built.status !== 0) {
	fail('The build failed.');
}

electron = spawn(
	path.join(packageDir, 'node_modules/.bin/electron'),
	['.', ...process.argv.slice(2)],
	{
		cwd: packageDir,
		env: {...process.env, DESKTOP_APP_URL: appUrl},
		stdio: 'inherit',
	},
);

electron.on('exit', (code) => {
	// Only a stack started here is stopped; one found running belongs to the terminal that ran it.
	if (!stack || stack.exitCode !== null) {
		process.exit(code ?? 0);
	}
	stack.on('exit', () => process.exit(code ?? 0));
	stack.kill('SIGTERM');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		electron?.kill('SIGTERM');
		stack?.kill('SIGTERM');
	});
}
