import {describe, expect, test} from 'bun:test';

import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import {quoted, SLACK_MARKDOWN_LIMIT, splitForSlack, toPlainSlackText, toSlackMarkdown} from './slack-markdown';

const APP = 'https://proxy.example.com';
const mark = ATTACHMENT_MARK;

describe('a thread’s Markdown as Slack is to show it', () => {
	const cases: Array<[string, string, string]> = [
		['plain words as they are', 'The flight leaves at **9:40**.', 'The flight leaves at **9:40**.'],
		['a picture as a link with its words', 'Here: ![Fares by month](https://files.example.com/chart.png)', 'Here: [Fares by month](https://files.example.com/chart.png)'],
		['a picture without words as a link called Picture', '![](https://files.example.com/a.png)', '[Picture](https://files.example.com/a.png)'],
		['a picture in the app under APP_URL', '![Seating plan](/acme/connections/drive?file=f1)', `[Seating plan](${APP}/acme/connections/drive?file=f1)`],
		['a link in the app under APP_URL', 'See [the thread](/acme/chat/p1/threads/t1).', `See [the thread](${APP}/acme/chat/p1/threads/t1).`],
		['a link elsewhere as it is', 'See [the fares](https://rail.example.com/fares).', 'See [the fares](https://rail.example.com/fares).'],
		['an address from a host’s root as it is', '[mirror](//cdn.example.com/x)', '[mirror](//cdn.example.com/x)'],
		['code left as written', 'Run `![x](/y)` then:\n\n```\n[a](/b)\n```', 'Run `![x](/y)` then:\n\n```\n[a](/b)\n```'],
		['a file’s mark between words out', `Does ${mark} match ${mark}?`, 'Does match?'],
		['a file’s mark on a line of its own out', `${mark}\nAnd this one`, 'And this one'],
		['marks alone as nothing', `${mark} ${mark}`, ''],
		['whitespace alone as nothing', '  \n\n ', ''],
	];

	for (const [name, text, shown] of cases) {
		test(name, () => {
			expect(toSlackMarkdown(text, APP)).toBe(shown);
		});
	}

	test('APP_URL with a trailing slash makes one slash', () => {
		expect(toSlackMarkdown('[open](/acme/chat)', `${APP}/`)).toBe(`[open](${APP}/acme/chat)`);
	});
});

describe('a message cut to Slack’s size', () => {
	test('leaves a message that fits whole', () => {
		expect(splitForSlack('One.\n\nTwo.')).toEqual(['One.\n\nTwo.']);
	});

	test('is nothing for nothing', () => {
		expect(splitForSlack('')).toEqual([]);
		expect(splitForSlack('\n\n  \n')).toEqual([]);
	});

	test('cuts at paragraphs’ ends, in order, each part within the limit', () => {
		const paragraph = (letter: string) => letter.repeat(40);
		const text = ['a', 'b', 'c', 'd', 'e'].map(paragraph).join('\n\n');

		const parts = splitForSlack(text, 90);

		expect(parts).toEqual([`${paragraph('a')}\n\n${paragraph('b')}`, `${paragraph('c')}\n\n${paragraph('d')}`, paragraph('e')]);
		expect(parts.join('\n\n')).toBe(text);
	});

	test('cuts a paragraph longer than a part at its lines’ ends, then at spaces', () => {
		expect(splitForSlack('line one\nline two\nline three', 18)).toEqual(['line one\nline two', 'line three']);
		expect(splitForSlack('word '.repeat(10).trim(), 12)).toEqual(['word word', 'word word', 'word word', 'word word', 'word word']);
	});

	test('keeps a block of code with blank lines in it as one paragraph', () => {
		const code = '```\nfirst\n\nsecond\n```';
		expect(splitForSlack(`Before.\n\n${code}\n\nAfter.`, code.length + 2)).toEqual(['Before.', code, 'After.']);
	});

	test('cuts a message longer than Slack takes into parts it takes', () => {
		const long = Array.from({length: 40}, (_, index) => `${index} ${'x'.repeat(600)}`).join('\n\n');

		const parts = splitForSlack(long);

		expect(parts.length).toBeGreaterThan(1);
		expect(parts.every((part) => part.length <= SLACK_MARKDOWN_LIMIT)).toBe(true);
		expect(parts.join('\n\n')).toBe(long);
	});
});

describe('a message Slack won’t take as Markdown', () => {
	test('plain text escapes Slack’s control characters and nothing else', () => {
		expect(toPlainSlackText('**Fares** < 100 & [more](https://x.example.com)')).toBe('**Fares** &lt; 100 &amp; [more](https://x.example.com)');
	});
});

describe('a quote', () => {
	test('quotes each line, a blank one too, so it is one paragraph', () => {
		expect(quoted('Book it\n\nThe 9:40')).toBe('> Book it\n>\n> The 9:40');
		expect(splitForSlack(quoted('Book it\n\nThe 9:40'))).toEqual(['> Book it\n>\n> The 9:40']);
	});
});
