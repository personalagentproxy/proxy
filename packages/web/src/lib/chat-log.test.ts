import {describe, expect, test} from 'bun:test';
import {keepEntries, type Sending, sameJson, settleSending} from '@/lib/chat-log';

type Entry = {id: string; from: 'person' | 'agent'; text: string};

const person = (id: string, text: string): Entry => ({id, from: 'person', text});
const agent = (id: string, text: string): Entry => ({id, from: 'agent', text});
const personText = (entry: Entry) => (entry.from === 'person' ? entry.text : null);

describe('sameJson', () => {
	test('compares what was read by its JSON', () => {
		expect(sameJson({a: 1, b: [2]}, {a: 1, b: [2]})).toBe(true);
		expect(sameJson({a: 1, b: [2]}, {a: 1, b: [3]})).toBe(false);
	});
});

describe('keepEntries', () => {
	test('keeps the very list where nothing in it changed', () => {
		const before = [person('e1', 'Hi'), agent('e2', 'Hello')];
		const after = [person('e1', 'Hi'), agent('e2', 'Hello')];

		expect(keepEntries(before, after)).toBe(before);
	});

	test('keeps each entry that didn’t change, and takes the new one where it did or came', () => {
		const before = [person('e1', 'Hi'), agent('e2', 'Working on it')];
		const after = [person('e1', 'Hi'), agent('e2', 'Done'), person('e3', 'Thanks')];

		const kept = keepEntries(before, after);

		expect(kept).toEqual(after);
		expect(kept[0]).toBe(before[0]);
		expect(kept[1]).toBe(after[1]);
		expect(kept[2]).toBe(after[2]);
	});

	test('drops what is gone', () => {
		const hi = person('e1', 'Hi');

		expect(keepEntries([hi, agent('e2', 'Hello')], [hi])).toEqual([hi]);
	});
});

describe('settleSending', () => {
	const sent = (
		key: string,
		text: string,
		id: string | null,
		before: string[],
	): Sending<Entry> => ({
		key,
		entry: person(key, text),
		id,
		before: new Set(before),
	});

	test('waits for what the chat doesn’t have yet', () => {
		const entries = [person('e1', 'Hi')];

		const {waiting, arrived} = settleSending(
			[sent('k1', 'Book the train', null, ['e1'])],
			entries,
			personText,
		);

		expect(waiting.map((sending) => sending.key)).toEqual(['k1']);
		expect(arrived.size).toBe(0);
	});

	test('finds what was sent by the id the server answered with', () => {
		const entries = [person('e1', 'Book the train'), person('e2', 'Book the train')];

		const {waiting, arrived} = settleSending(
			[sent('k1', 'Book the train', 'e2', [])],
			entries,
			personText,
		);

		expect(waiting).toEqual([]);
		expect([...arrived]).toEqual([['e2', 'k1']]);
	});

	test('finds what was sent by its text among what the chat didn’t have as it was sent', () => {
		const entries = [
			person('e1', 'Book the train'),
			agent('e2', 'Book the train'),
			person('e3', 'Book the train'),
		];

		const {waiting, arrived} = settleSending(
			[sent('k1', 'Book the train', null, ['e1', 'e2'])],
			entries,
			personText,
		);

		expect(waiting).toEqual([]);
		expect([...arrived]).toEqual([['e3', 'k1']]);
	});

	test('takes two of the same text for two entries, in order', () => {
		const entries = [person('e1', 'Yes'), person('e2', 'Yes')];

		const {waiting, arrived} = settleSending(
			[sent('k1', 'Yes', null, []), sent('k2', 'Yes', null, []), sent('k3', 'Yes', null, [])],
			entries,
			personText,
		);

		expect([...arrived]).toEqual([
			['e1', 'k1'],
			['e2', 'k2'],
		]);
		expect(waiting.map((sending) => sending.key)).toEqual(['k3']);
	});
});
