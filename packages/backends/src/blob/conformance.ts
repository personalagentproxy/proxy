import {beforeAll, describe, expect, test} from 'bun:test';

import type {BlobBackend} from './backend';

/**
 * What every blob backend has to do, as tests: a backend's own test file calls `blobBackendTests`
 * with how to make one, empty.
 */

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

const bytes = (text: string) => new TextEncoder().encode(text);

async function read(backend: BlobBackend, key: string): Promise<string> {
	return new Response((await backend.get(key)).unwrap()).text();
}

/** Registers the tests of the contract on the backend `make` gives, made once for all of them. */
export function blobBackendTests(make: () => Promise<BlobBackend>): void {
	describe('as a blob backend', () => {
		let backend: BlobBackend;

		beforeAll(async () => {
			backend = await make();
		});

		test('keeps what it is given under its key, byte for byte, however it came in pieces', async () => {
			(await backend.put('org-1/hello', streamOf(bytes('hel'), bytes('lo '), bytes('there')))).unwrap();
			const binary = new Uint8Array(70_000).map((_, index) => index % 251);
			(await backend.put('org-1/binary', streamOf(binary.slice(0, 1000), binary.slice(1000)))).unwrap();

			expect(await read(backend, 'org-1/hello')).toBe('hello there');
			expect(new Uint8Array(await new Response((await backend.get('org-1/binary')).unwrap()).arrayBuffer())).toEqual(binary);
		});

		test('keeps an empty blob', async () => {
			(await backend.put('org-1/empty', streamOf())).unwrap();

			expect(await read(backend, 'org-1/empty')).toBe('');
		});

		test('keeps each key’s blob apart, and what was written last under one written again', async () => {
			(await backend.put('org-1/a', streamOf(bytes('one')))).unwrap();
			(await backend.put('org-2/a', streamOf(bytes('two')))).unwrap();
			(await backend.put('org-1/a', streamOf(bytes('three')))).unwrap();

			expect(await read(backend, 'org-1/a')).toBe('three');
			expect(await read(backend, 'org-2/a')).toBe('two');
		});

		test('has nothing under a key never written, and removing it is no error', async () => {
			expect((await backend.get('org-1/never')).unwrapErr().kind).toBe('not_found');
			expect((await backend.delete('org-1/never')).isOk()).toBe(true);
		});

		test('removes a blob for good', async () => {
			(await backend.put('org-1/going', streamOf(bytes('soon gone')))).unwrap();

			(await backend.delete('org-1/going')).unwrap();

			expect((await backend.get('org-1/going')).unwrapErr().kind).toBe('not_found');
		});

		test('keeps nothing of a body that fails partway', async () => {
			const failing = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes('half of '));
				},
				pull(controller) {
					controller.error(new Error('the connection dropped'));
				},
			});

			expect((await backend.put('org-1/half', failing)).isErr()).toBe(true);
			expect((await backend.get('org-1/half')).unwrapErr().kind).toBe('not_found');
		});

		test('refuses a key that is not the api’s kind, so none is a path out of the store', async () => {
			for (const key of ['../outside', '/absolute', 'org-1/../../outside', 'org-1//double', 'org 1/space', '']) {
				expect((await backend.put(key, streamOf(bytes('x')))).unwrapErr().kind).toBe('validation_error');
				expect((await backend.get(key)).unwrapErr().kind).toBe('validation_error');
				expect((await backend.delete(key)).unwrapErr().kind).toBe('validation_error');
			}
		});
	});
}
