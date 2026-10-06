#!/usr/bin/env node

// `bun run dev`: the local database first, then the api and the web app once it is ready.

import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';
const READY_LINE = '[db] Database ready';

const children = [];

// Each child leads its own process group, so stopping it also stops what it started (the api and
// web under `bun run --filter`).
function start(args) {
	const child = spawn(bunCommand, args, {
		cwd: root,
		detached: true,
		stdio: ['inherit', 'pipe', 'inherit'],
	});
	children.push(child);
	child.on('exit', (code) => stopAll(code ?? 0));
	return child;
}

let stopping = false;
function stopAll(code) {
	if (stopping) {
		return;
	}
	stopping = true;
	for (const child of children) {
		process.kill(-child.pid, 'SIGTERM');
	}
	process.exitCode = code;
}

process.once('SIGINT', () => stopAll(0));
process.once('SIGTERM', () => stopAll(0));

const db = start(['run', '--cwd', 'packages/db', 'db:dev']);
let apps = null;
db.stdout.on('data', (chunk) => {
	process.stdout.write(chunk);
	if (apps || !chunk.toString().includes(READY_LINE)) {
		return;
	}

	apps = start(['run', '--filter', './packages/*', 'dev']);
	apps.stdout.pipe(process.stdout);
});
