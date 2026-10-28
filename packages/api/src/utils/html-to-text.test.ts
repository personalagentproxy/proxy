import {expect, test} from 'bun:test';

import {htmlToText} from './html-to-text';

test('htmlToText finds the end of a hidden element after a letter that lowercases to two', () => {
	expect(htmlToText('<p>İstanbul</p><STYLE>p {}</STYLE><p>after</p>')).toBe('İstanbul\nafter');
	expect(htmlToText(`<p>${'İ'.repeat(12)} before</p><style>a > b {}</style><p>after</p><p>more</p>`)).toBe(`${'İ'.repeat(12)} before\nafter\nmore`);
});

test('htmlToText decodes entities only once the tags are gone', () => {
	expect(htmlToText('<p>&lt;b&gt; is bold &#8212; &#x263A;</p>')).toBe('<b> is bold — ☺');
});

test('htmlToText reads a number Unicode has no character for as the replacement character', () => {
	expect(htmlToText('<p>a&#99999999;b&#x110000;c&#0;d</p>')).toBe('a\uFFFDb\uFFFDc\uFFFDd');
});

test('htmlToText keeps the text of unclosed tags, and of a link that never ends', () => {
	expect(htmlToText('<p>Hi <b>there<!-- note')).toBe('Hi there');
	expect(htmlToText('See <a href="https://example.com">this')).toBe('See this');
	expect(htmlToText('1 < 2 and <script>gone')).toBe('1 < 2 and');
	expect(htmlToText('<A HREF="https://example.com">Go</A><BR>on<SCRIPT>x</SCRIPT>')).toBe('Go (https://example.com)\non');
});

test('htmlToText takes time in proportion to the email, however many tags are left open', () => {
	const started = performance.now();
	htmlToText(`${'<a href="x">y'.repeat(100_000)}${'<'.repeat(100_000)}${'<!--'.repeat(100_000)}`);

	expect(performance.now() - started).toBeLessThan(1000);
});
