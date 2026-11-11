import {afterAll, expect, test} from 'bun:test';

import {blobBackendTests} from './conformance';
import {s3BlobBackend} from './s3';

/**
 * The bucket's side, against a stand-in that speaks as much of S3's protocol as a blob needs: an
 * object put, read, asked after and deleted at its path, in a bucket named in the path. Whatever
 * signs a request is not checked. A real bucket is what a deployment's own smoke test is for.
 */

const objects = new Map<string, ArrayBuffer>();

const bucket = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = decodeURIComponent(new URL(request.url).pathname);
		if (request.method === 'PUT') {
			objects.set(path, await request.arrayBuffer());
			return new Response(null, {status: 200, headers: {etag: '"stand-in"'}});
		}
		if (request.method === 'DELETE') {
			objects.delete(path);
			return new Response(null, {status: 204});
		}
		const found = objects.get(path);
		if (found === undefined) {
			return new Response('<Error><Code>NoSuchKey</Code></Error>', {status: 404, headers: {'content-type': 'application/xml'}});
		}
		const headers = {'content-length': String(found.byteLength), etag: '"stand-in"'};
		return request.method === 'HEAD' ? new Response(null, {headers}) : new Response(found, {headers});
	},
});

afterAll(() => bucket.stop(true));

const config = {bucket: 'files', endpoint: `http://localhost:${bucket.port}`, region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret'};

blobBackendTests(async () => s3BlobBackend(config));

test('keeps every blob under the prefix, so the bucket can hold more than this', async () => {
	const backend = s3BlobBackend({...config, prefix: 'proxy'});

	(await backend.put('org-1/under', new Response('kept').body ?? new ReadableStream())).unwrap();

	expect(new TextDecoder().decode(objects.get('/files/proxy/org-1/under'))).toBe('kept');
	expect(await new Response((await backend.get('org-1/under')).unwrap()).text()).toBe('kept');
});
