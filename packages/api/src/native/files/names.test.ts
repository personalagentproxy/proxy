import {describe, expect, test} from 'bun:test';

import {chatFolder, isShownImage, mediaType, requireFileName} from './names';

describe('requireFileName', () => {
	test('keeps a name as it is, trimmed', () => {
		expect(requireFileName('  Q3 report (final).pdf ').unwrap()).toBe('Q3 report (final).pdf');
		expect(requireFileName('.env').unwrap()).toBe('.env');
		expect(requireFileName('Übersicht 2026.md').unwrap()).toBe('Übersicht 2026.md');
	});

	test('refuses what is no one thing’s name: nothing, a place, a path, a line break, or too long', () => {
		for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'two\nlines', 'tab\there', 'x'.repeat(256)]) {
			expect(requireFileName(name).unwrapErr().kind, JSON.stringify(name)).toBe('validation_error');
		}
	});
});

describe('mediaType', () => {
	test('reads a file by its extension, whatever it was sent as', () => {
		expect(mediaType('notes.md', undefined, 'text')).toBe('text/markdown');
		expect(mediaType('Report.PDF', 'application/octet-stream', 'bytes')).toBe('application/pdf');
		expect(mediaType('page.html', 'image/png', 'bytes')).toBe('text/html');
		expect(mediaType('main.py', undefined, 'bytes')).toBe('text/plain');
	});

	test('takes the sender’s word where the name says nothing, without its parameters, and only a media type', () => {
		expect(mediaType('scan', 'image/tiff', 'bytes')).toBe('image/tiff');
		expect(mediaType('notes', 'text/plain; charset=utf-8', 'bytes')).toBe('text/plain');
		expect(mediaType('data.unknown', 'not a type\r\nx-injected: 1', 'bytes')).toBe('application/octet-stream');
	});

	test('falls back to text for what was written as text, and to bytes for what was uploaded', () => {
		expect(mediaType('Makefile', undefined, 'text')).toBe('text/plain');
		expect(mediaType('Makefile', undefined, 'bytes')).toBe('application/octet-stream');
		expect(mediaType('blob', 'application/octet-stream', 'text')).toBe('text/plain');
	});
});

describe('isShownImage', () => {
	test('shows the pictures with nothing in them that runs, never an SVG or a page', () => {
		expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map(isShownImage)).toEqual([true, true, true, true]);
		expect(['image/svg+xml', 'text/html', 'application/pdf', 'image/heic'].map(isShownImage)).toEqual([false, false, false, false]);
	});
});

describe('chatFolder', () => {
	test('is the persona’s folder under Chats, and a sub-agent’s title’s in it, each as a folder may be named', () => {
		expect(chatFolder('Coding Agent', null)).toBe('Chats/Coding Agent');
		expect(chatFolder('Coding Agent', 'Show all active tasks in sidebar')).toBe('Chats/Coding Agent/Show all active tasks in sidebar');
		expect(chatFolder('R&D / Ops', 'Q3 a/b test')).toBe('Chats/R&D   Ops/Q3 a b test');
		// What can't be a folder's name: the persona's is Agent, as for what the person attaches; a title's is left out.
		expect(chatFolder('..', '  ')).toBe('Chats/Agent');
	});
});
