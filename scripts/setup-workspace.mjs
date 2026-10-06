#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {lstatSync, rmSync, symlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';
const conductorRootPath = process.env.CONDUCTOR_ROOT_PATH ?? process.env.EMDASH_ROOT_PATH;

if (!conductorRootPath) {
	console.error('CONDUCTOR_ROOT_PATH or EMDASH_ROOT_PATH is required for workspace setup.');
	process.exit(1);
}

runCommand('bun install', ['install', '--frozen-lockfile']);
runCommand('bun run setup', ['run', 'setup']);

linkFile(join(conductorRootPath, '.env'), join(root, '.env'));

console.log('Workspace setup complete.');
process.exit(0);

function runCommand(label, args) {
	const result = spawnSync(bunCommand, args, {
		cwd: root,
		stdio: 'inherit',
	});

	if (!result.error && result.status === 0) {
		return;
	}

	if (result.error) {
		console.error(`Failed to run ${label}:`, result.error.message);
		process.exit(1);
	}

	process.exit(result.status ?? 1);
}

function linkFile(sourcePath, targetPath) {
	if (sourcePath === targetPath) {
		console.log(`Skipped ${targetPath}`);
		return;
	}

	try {
		const stat = lstatSync(targetPath);

		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			rmSync(targetPath, {recursive: true, force: true});
		} else {
			rmSync(targetPath, {force: true});
		}
	} catch {
		// Doesn't exist, which is fine.
	}

	symlinkSync(sourcePath, targetPath);
	console.log(`Linked ${targetPath}`);
}
