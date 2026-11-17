import {beforeEach, describe, expect, test} from 'bun:test';
import {lastThread, personaChatPath, rememberLastThread} from './last-thread';

describe('last thread per persona', () => {
	beforeEach(() => localStorage.clear());

	test('opens the chat where no thread was open', () => {
		expect(personaChatPath('acme', 'p1')).toBe('/acme/chat/p1');
	});

	test('goes back to the thread last open in each chat', () => {
		rememberLastThread('acme', 'p1', 't1');
		rememberLastThread('acme', 'p2', 't2');
		rememberLastThread('acme', 'p1', 't3');
		expect(personaChatPath('acme', 'p1')).toBe('/acme/chat/p1/threads/t3');
		expect(personaChatPath('acme', 'p2')).toBe('/acme/chat/p2/threads/t2');
	});

	test('forgets the thread once it is closed', () => {
		rememberLastThread('acme', 'p1', 't1');
		rememberLastThread('acme', 'p1', null);
		expect(lastThread('acme', 'p1')).toBeNull();
		expect(personaChatPath('acme', 'p1')).toBe('/acme/chat/p1');
	});

	test('keeps each organization apart', () => {
		rememberLastThread('acme', 'p1', 't1');
		expect(lastThread('other', 'p1')).toBeNull();
	});

	test('ignores what it cannot read', () => {
		localStorage.setItem('proxy.last-thread.acme', 'not json');
		expect(lastThread('acme', 'p1')).toBeNull();
		rememberLastThread('acme', 'p1', 't1');
		expect(lastThread('acme', 'p1')).toBe('t1');
	});
});
