import {describe, expect, test} from 'bun:test';

import {errPacket, leadingPackets, pktLine, pushedRefs, sidebandError} from './pkt-line';

const ZERO = '0'.repeat(40);
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const FLUSH = Buffer.from('0000');

function packets(...payloads: string[]): Buffer {
	return Buffer.concat(payloads.map(pktLine));
}

describe('pkt-lines', () => {
	test('a packet is its length in hex, four digits counted, then its payload', () => {
		expect(pktLine('# service=git-upload-pack\n').toString()).toBe('001e# service=git-upload-pack\n');
		expect(errPacket('Not allowed').toString()).toBe('0013ERR Not allowed');
		expect(sidebandError('No').toString()).toBe('0008\x03No\n');
	});

	test('the leading packets are read to the flush, and a cut-off one is left out', () => {
		const whole = Buffer.concat([packets('one\n', 'two\n'), FLUSH, Buffer.from('PACK…')]);

		expect(leadingPackets(whole)).toEqual({payloads: ['one\n', 'two\n'], flushed: true});
		expect(leadingPackets(whole.subarray(0, 12))).toEqual({payloads: ['one\n'], flushed: false});
		expect(leadingPackets(Buffer.from('PACK'))).toEqual({payloads: [], flushed: false});
	});
});

describe('the refs a push updates', () => {
	test('each command’s ref, the first’s capabilities left out, deletions marked', () => {
		const start = Buffer.concat([
			packets(`${OLD} ${NEW} refs/heads/fix-login\0report-status side-band-64k agent=git/2.50`, `${ZERO} ${NEW} refs/tags/v1.2`, `${OLD} ${ZERO} refs/heads/old`),
			FLUSH,
			Buffer.from('PACK'),
		]);

		expect(pushedRefs(start)).toEqual({
			refs: [
				{ref: 'refs/heads/fix-login', deleted: false},
				{ref: 'refs/tags/v1.2', deleted: false},
				{ref: 'refs/heads/old', deleted: true},
			],
			complete: true,
		});
	});

	test('a shallow push’s shallow lines are no ref; a start cut short says so', () => {
		const start = packets(`shallow ${OLD}`, `${OLD} ${NEW} refs/heads/main\0report-status`);

		expect(pushedRefs(start)).toEqual({refs: [{ref: 'refs/heads/main', deleted: false}], complete: false});
	});
});
