import {afterAll, beforeAll, describe, expect, test} from 'bun:test';

import type {SandboxBackend, SandboxRef} from './backend';

/**
 * What every sandbox backend has to do, as tests: a backend's own test file calls
 * `sandboxBackendTests` with how to make one. The commands are plain POSIX shell, so any backend
 * with a shell and the usual tools passes them as it is.
 */

const TIMEOUT_MS = 30_000;

/** Registers the tests of the contract on the backend `make` gives, made once for all of them. */
export function sandboxBackendTests(make: () => Promise<SandboxBackend>): void {
	describe('as a sandbox backend', () => {
		let backend: SandboxBackend;
		const made: SandboxRef[] = [];

		const create = async (sandboxId: string, tenant = 'org-1'): Promise<SandboxRef> => {
			const ref = (await backend.create({tenant, sandboxId})).unwrap();
			made.push(ref);
			return ref;
		};
		const exec = async (ref: SandboxRef, command: string, stdin?: string) => (await backend.exec(ref, {command, stdin, timeoutMs: TIMEOUT_MS})).unwrap();

		beforeAll(async () => {
			backend = await make();
		});

		afterAll(async () => {
			for (const ref of made) {
				await backend.destroy(ref);
			}
		});

		test('a new sandbox runs commands in a home of its own, fed stdin, and says what they wrote and how they ended', async () => {
			const ref = await create('fresh');

			expect(await exec(ref, 'echo hello; echo oops >&2; exit 3')).toEqual({stdout: 'hello\n', stderr: 'oops\n', exitCode: 3, timedOut: false});
			expect(await exec(ref, 'cat > note.txt; wc -c < note.txt | tr -d " "', 'hi there')).toMatchObject({stdout: '8\n', exitCode: 0});
			expect(await exec(ref, 'test "$(pwd)" = "$HOME" && test -f "$HOME/note.txt" && echo home')).toMatchObject({stdout: 'home\n', exitCode: 0});
		});

		test('a command runs where cwd says, under the home', async () => {
			const ref = await create('cwd');
			await exec(ref, 'mkdir -p repo && echo inside > repo/file');

			expect((await backend.exec(ref, {command: 'cat file', cwd: 'repo', timeoutMs: TIMEOUT_MS})).unwrap()).toMatchObject({stdout: 'inside\n', exitCode: 0});
		});

		test('what was written stays while the sandbox is asleep, and is there once it is woken', async () => {
			const ref = await create('kept');
			await exec(ref, 'echo kept > kept.txt');
			const asleep = (await backend.sleep(ref)).unwrap();
			const woken = (await backend.wake(asleep)).unwrap();
			made.push(woken);

			expect(await exec(woken, 'cat kept.txt')).toMatchObject({stdout: 'kept\n', exitCode: 0});
		});

		test('sleeping ends what the sandbox was running', async () => {
			const ref = await create('busy');
			await exec(ref, 'nohup sleep 300 >/dev/null 2>&1 & echo $! > pid');
			expect(await exec(ref, 'kill -0 "$(cat pid)" && echo alive')).toMatchObject({stdout: 'alive\n'});
			const woken = (await backend.wake((await backend.sleep(ref)).unwrap())).unwrap();
			made.push(woken);

			// A process just killed may be a moment from being reaped, which kill -0 still counts.
			let last = '';
			for (let tries = 0; tries < 20 && last !== 'gone\n'; tries++) {
				last = (await exec(woken, 'kill -0 "$(cat pid)" 2>/dev/null && echo alive || echo gone')).stdout;
			}
			expect(last).toBe('gone\n');
		});

		test('sandboxes keep apart, of one tenant and of two', async () => {
			const one = await create('one');
			const two = await create('two');
			const other = await create('one', 'org-2');
			await exec(one, 'echo mine > mine.txt');

			expect(await exec(two, 'cat mine.txt')).toMatchObject({stdout: '', exitCode: 1});
			expect(await exec(other, 'cat mine.txt')).toMatchObject({stdout: '', exitCode: 1});
		});

		test('a command past its timeout is stopped, and says so', async () => {
			const ref = await create('slow');
			const started = Date.now();

			expect((await backend.exec(ref, {command: 'echo begun; sleep 20; echo done', timeoutMs: 500})).unwrap()).toMatchObject({stdout: 'begun\n', exitCode: null, timedOut: true});
			expect(Date.now() - started).toBeLessThan(10_000);
		});

		test('a sandbox destroyed is gone, and a ref the backend never made is not found', async () => {
			const ref = await create('gone');
			(await backend.destroy(ref)).unwrap();

			expect((await backend.exec(ref, {command: 'true', timeoutMs: TIMEOUT_MS})).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'sandbox'});
			expect((await backend.wake('nothing-of-the-kind')).unwrapErr()).toMatchObject({kind: 'not_found'});
			expect((await backend.destroy('nothing-of-the-kind')).unwrapErr()).toMatchObject({kind: 'not_found'});
		});
	});
}
