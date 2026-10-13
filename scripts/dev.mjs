#!/usr/bin/env node

// `bun run dev`: the local database first, then the api and the web app once it is ready. A `bun
// run dev` already running holds the same ports, so it is stopped first and this one takes over.

import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';
const READY_LINE = '[db] Database ready';
// Where the running `bun run dev` notes its pid and its children's process groups. In the temp
// directory rather than the checkout, since every checkout on the machine uses the same ports.
const STATE_FILE = join(tmpdir(), 'proxy-dev.json');
// Long enough for the database to close cleanly before it is killed.
const STOP_TIMEOUT_MS = 10_000;

const children = [];

await stopPrevious();
writeState();
process.on('exit', removeState);

// Each child leads its own process group, so stopping it also stops what it started (the api and
// web under `bun run --filter`).
function start(args) {
	const child = spawn(bunCommand, args, {
		cwd: root,
		detached: true,
		stdio: ['inherit', 'pipe', 'inherit'],
	});
	children.push(child);
	writeState();
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
		signal(-child.pid, 'SIGTERM');
	}
	process.exitCode = code;
}

// Stops the `bun run dev` noted in the state file, and the process groups it started even if it
// died without stopping them, then waits until they are gone.
async function stopPrevious() {
	const state = readState();
	if (!state) {
		return;
	}

	const pids = [
		...(isOurs(state.pid, 'scripts/dev.mjs') ? [state.pid] : []),
		...state.groups.filter((group) => isOurs(group, bunCommand)).map((group) => -group),
	];
	if (pids.length === 0) {
		return;
	}

	console.log(`[dev] Stopping the bun run dev already running (pid ${state.pid})`);
	for (const pid of pids) {
		signal(pid, 'SIGTERM');
	}
	if (await waitForExit(pids, STOP_TIMEOUT_MS)) {
		return;
	}

	for (const pid of pids) {
		signal(pid, 'SIGKILL');
	}
	await waitForExit(pids, 2_000);
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
	} catch {
		return null;
	}
}

function writeState() {
	const state = {pid: process.pid, groups: children.map((child) => child.pid)};
	writeFileSync(STATE_FILE, JSON.stringify(state));
}

// The next `bun run dev` may have written the file already, so only our own is removed.
function removeState() {
	if (readState()?.pid !== process.pid) {
		return;
	}
	rmSync(STATE_FILE, {force: true});
}

// Whether the process is still running what we started, not something that got its pid later.
function isOurs(pid, command) {
	if (!isRunning(pid)) {
		return false;
	}

	try {
		return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8'}).includes(
			command,
		);
	} catch {
		return false;
	}
}

function isRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

// A process that is already gone is fine: that is what stopping it was for.
function signal(pid, name) {
	try {
		process.kill(pid, name);
	} catch (error) {
		if (error.code !== 'ESRCH') {
			throw error;
		}
	}
}

async function waitForExit(pids, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pids.some(isRunning)) {
			return true;
		}
		await sleep(100);
	}
	return false;
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
