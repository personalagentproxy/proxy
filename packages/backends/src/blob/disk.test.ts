import {expect, test} from 'bun:test';
import {mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {blobBackendTests} from './conformance';
import {diskBlobBackend} from './disk';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'proxy-blobs-'));

blobBackendTests(async () => diskBlobBackend(freshRoot()));

test('a body that fails partway leaves no file behind, not even the part written', async () => {
	const root = freshRoot();
	const failing = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('half of '));
		},
		pull(controller) {
			controller.error(new Error('the connection dropped'));
		},
	});

	expect((await diskBlobBackend(root).put('org-1/half', failing)).isErr()).toBe(true);

	expect(readdirSync(join(root, 'org-1'))).toEqual([]);
});
