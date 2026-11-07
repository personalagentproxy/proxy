/**
 * The lines of a stream of text, as they come, without their newlines; a last line without one is
 * left out. With `budget`, it stops once more than `budget.max` bytes have come in all, which
 * `budget.bytes` then says, so a stream that never ends a line can't fill memory.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>, budget?: {bytes: number; max: number}): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of stream) {
		if (budget) {
			budget.bytes += chunk.byteLength;
			if (budget.bytes > budget.max) {
				return;
			}
		}
		buffer += decoder.decode(chunk, {stream: true});
		let end = buffer.indexOf('\n');
		while (end !== -1) {
			yield buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf('\n');
		}
	}
}
