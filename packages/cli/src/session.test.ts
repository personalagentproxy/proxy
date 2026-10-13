import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtemp, rm, stat, writeFile, mkdir, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
	configDir,
	readSession,
	removeSession,
	requireLive,
	writeSession,
	type Session,
} from './session';

const session: Session = {
	origin: 'https://proxy.example.com',
	cookie: {name: '__Secure-proxy.agent-session', value: 'abc123'},
	expires: '2026-10-20T12:00:00.000Z',
};

let home = '';

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'proxy-cli-'));
});

afterEach(async () => {
	await rm(home, {recursive: true, force: true});
});

describe('the session file', () => {
	test('is kept readable by its owner alone, in a folder only they can open', async () => {
		const dir = join(home, 'proxy');
		(await writeSession(dir, session)).unwrap();

		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect((await stat(join(dir, 'session.json'))).mode & 0o777).toBe(0o600);
		expect((await readSession(dir)).unwrap()).toEqual(session);
	});

	test('narrows a folder that was open to others', async () => {
		const dir = join(home, 'proxy');
		await mkdir(dir);
		await chmod(dir, 0o755);
		(await writeSession(dir, session)).unwrap();

		expect((await stat(dir)).mode & 0o777).toBe(0o700);
	});

	test('missing is no session; one that is not a session says to log in again', async () => {
		expect((await readSession(join(home, 'none'))).unwrap()).toBeNull();

		await writeFile(join(home, 'session.json'), '{"origin": 1}');
		expect((await readSession(home)).unwrapErr().message).toContain('run proxy login again');
	});

	test('removing it twice is fine', async () => {
		(await writeSession(home, session)).unwrap();
		(await removeSession(home)).unwrap();
		(await removeSession(home)).unwrap();
		expect((await readSession(home)).unwrap()).toBeNull();
	});
});

test('a session counts until it ends', () => {
	expect(requireLive(session, new Date('2026-10-20T11:59:00Z')).isOk()).toBe(true);
	expect(requireLive(session, new Date('2026-10-20T12:00:00Z')).unwrapErr().message).toContain(
		'ended',
	);
	expect(requireLive(null, new Date()).unwrapErr().message).toContain('Not signed in');
});

test('lives in XDG_CONFIG_HOME, else ~/.config', () => {
	expect(configDir({XDG_CONFIG_HOME: '/x/config'})).toBe('/x/config/proxy');
	expect(configDir({})).toEndWith('/.config/proxy');
});
