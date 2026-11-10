import {constants, gunzipSync} from 'node:zlib';

import {Result} from 'ts-results-es';

/**
 * git's pkt-lines, as far as relaying its requests needs them: an `ERR` packet, which git prints as
 * `fatal: remote error: <message>`, for a refusal it shows; and what the start of an upload-pack or
 * receive-pack request says, read from the bytes peeked at before it is relayed (peek.ts), for the
 * activity log: whether an upload-pack request fetches, and the refs a push updates. Each packet is
 * four hex digits of its length, those four included, then its payload; `0000` ends a list,
 * `0001` divides one.
 */

// The most a packet's payload may be, as git sets it.
const MAX_PAYLOAD = 65516;

/** One packet with `payload`. */
export function pktLine(payload: string): Buffer {
	const bytes = Buffer.from(payload);
	return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}

/** An `ERR` packet: what git shows of a refusal, as `fatal: remote error: <message>`. */
export function errPacket(message: string): Buffer {
	return pktLine(`ERR ${message}`.slice(0, MAX_PAYLOAD));
}

/**
 * A fatal error on side-band 3, as a receive-pack answer to a push that asked for the side band,
 * as every git does where the server offers it, and GitHub does: git prints it as
 * `remote error: <message>`, where it would take an `ERR` packet there for a malformed band.
 */
export function sidebandError(message: string): Buffer {
	return pktLine(`\x03${message}\n`.slice(0, MAX_PAYLOAD));
}

/** The payloads of the packets at the start of `bytes`, up to the first flush, and whether one was reached. */
export function leadingPackets(bytes: Buffer): {payloads: string[]; flushed: boolean} {
	const payloads: string[] = [];
	let at = 0;
	while (at + 4 <= bytes.length) {
		const head = bytes.subarray(at, at + 4).toString('latin1');
		if (!/^[0-9a-f]{4}$/i.test(head)) {
			return {payloads, flushed: false};
		}
		const length = Number.parseInt(head, 16);
		if (length === 0) {
			return {payloads, flushed: true};
		}
		if (length < 4) {
			at += 4;
			continue;
		}
		if (at + length > bytes.length) {
			return {payloads, flushed: false};
		}
		payloads.push(bytes.subarray(at + 4, at + length).toString('utf8'));
		at += length;
	}
	return {payloads, flushed: false};
}

/**
 * The start of a request body as git wrote it, from the bytes peeked: inflated, as far as they go,
 * where git gzipped it; null where they don't inflate.
 */
export function requestStart(peeked: Buffer, contentEncoding: string | undefined): Buffer | null {
	const encoding = (contentEncoding ?? '').trim().toLowerCase();
	if (encoding === '' || encoding === 'identity') {
		return peeked;
	}
	if (encoding !== 'gzip' && encoding !== 'x-gzip') {
		return null;
	}
	// A sync flush inflates what there is of a stream cut short, rather than failing for its end.
	return Result.wrap(() => gunzipSync(peeked, {finishFlush: constants.Z_SYNC_FLUSH})).unwrapOr(null);
}

/**
 * Whether an upload-pack request fetches: protocol v2's `command=fetch`, or the `want` lines of the
 * protocol before it; not v2's `ls-refs`, which only lists. Null where its start doesn't say.
 */
export function uploadPackFetches(start: Buffer): boolean | null {
	const [first] = leadingPackets(start).payloads;
	if (first === undefined) {
		return null;
	}
	const line = first.replace(/\n$/, '');
	if (line.startsWith('command=')) {
		return line === 'command=fetch';
	}
	if (line.startsWith('want ')) {
		return true;
	}
	return null;
}

/** A ref a push updates: `refs/heads/fix-login`, and whether the push deletes it. */
export type PushedRef = {ref: string; deleted: boolean};

/**
 * The refs a receive-pack request updates, from its commands, `<old> <new> <ref>` before the first
 * flush, the first with git's capabilities after a NUL; `complete` false where the peek ended before
 * the flush did.
 */
export function pushedRefs(start: Buffer): {refs: PushedRef[]; complete: boolean} {
	const {payloads, flushed} = leadingPackets(start);
	const refs = payloads.flatMap((payload) => {
		const [command = ''] = payload.split('\0');
		const [old, next, ref] = command.replace(/\n$/, '').split(' ');
		if (old === undefined || next === undefined || ref === undefined || !/^[0-9a-f]+$/.test(old) || !/^[0-9a-f]+$/.test(next)) {
			return [];
		}
		return [{ref, deleted: /^0+$/.test(next)}];
	});
	return {refs, complete: flushed};
}
