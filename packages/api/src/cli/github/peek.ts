import type {IncomingMessage} from 'node:http';

/**
 * A request's body as a stream to relay, with what its start says read on the way: its first
 * chunks are read until there are `limit` bytes of them, or `enough` says they are enough, or the
 * body ends, and the stream relayed gives them first and the rest as it comes. So nothing more than
 * the start is ever held, and a pack streams through as git sends it.
 */

export type Peeked = {start: Buffer; body: ReadableStream<Uint8Array>};

export async function peekBody(request: IncomingMessage, limit: number, enough: (start: Buffer) => boolean): Promise<Peeked> {
	const reader = bodyStream(request).getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let done = false;
	while (size < limit) {
		const next = await reader.read();
		if (next.done) {
			done = true;
			break;
		}
		chunks.push(next.value);
		size += next.value.byteLength;
		if (enough(Buffer.concat(chunks))) {
			break;
		}
	}
	const start = Buffer.concat(chunks);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (start.byteLength > 0) {
				controller.enqueue(start);
			}
			if (done) {
				controller.close();
			}
		},
		async pull(controller) {
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return {start, body};
}

// A chunk of a request's body: bytes, unless something set an encoding on the stream.
function bytesOf(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** A request's body as a web stream, read from the request as it is pulled, for `fetch` to send on. */
export function bodyStream(request: IncomingMessage): ReadableStream<Uint8Array> {
	const chunks: AsyncIterator<Buffer | string> = request[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(bytesOf(next.value));
		},
		async cancel() {
			await chunks.return?.();
		},
	});
}

/** A request's whole body, or null once it is over `limit` bytes: for a GraphQL request, read to tell a query from a mutation. */
export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	const incoming: AsyncIterable<Buffer | string> = request;
	for await (const chunk of incoming) {
		const bytes = bytesOf(chunk);
		size += bytes.byteLength;
		if (size > limit) {
			return null;
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}
