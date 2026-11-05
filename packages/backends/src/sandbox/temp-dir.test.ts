import {describe, expect, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {sandboxBackendTests} from './conformance';
import {tempDirSandboxBackend} from './temp-dir';

const fresh = () => tempDirSandboxBackend(mkdtempSync(join(tmpdir(), 'proxy-sandboxes-')));

sandboxBackendTests(async () => fresh());

describe('tempDirSandboxBackend', () => {
	test('gives a command nothing of this process’s environment, and keeps only so much of what it writes', async () => {
		const backend = fresh();
		const ref = (await backend.create({tenant: 'org-1', sandboxId: 'env'})).unwrap();

		const seen = (await backend.exec(ref, {command: 'env | cut -d= -f1 | sort | tr "\\n" " "', timeoutMs: 10_000})).unwrap();
		expect(
			seen.stdout
				.trim()
				.split(' ')
				.filter((name) => !['PATH', 'HOME', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(name)),
		).toEqual([]);
		const long = (await backend.exec(ref, {command: 'head -c 2000000 /dev/zero | tr "\\0" x', timeoutMs: 10_000})).unwrap();
		expect(long.stdout.length).toBe(1_000_000);
		(await backend.destroy(ref)).unwrap();
	});

	test('a ref outside its own directory is not found, however the path is written', async () => {
		const backend = fresh();
		expect((await backend.exec('/tmp', {command: 'true', timeoutMs: 1_000})).unwrapErr()).toMatchObject({kind: 'not_found'});
		expect((await backend.exec('/tmp/../tmp', {command: 'true', timeoutMs: 1_000})).unwrapErr()).toMatchObject({kind: 'not_found'});
	});
});
