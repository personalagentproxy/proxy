import {describe, expect, test} from 'bun:test';

import {markdownImages, readFileLink} from './file-links';

const ORIGIN = 'https://app.example.com';

describe('readFileLink', () => {
	test('reads the organization, the drive and the file of a link to a file', () => {
		expect(
			readFileLink(`${ORIGIN}/acme/connections/drive-1?folder=folder-1&file=file-1`, ORIGIN),
		).toEqual({org: 'acme', connectionId: 'drive-1', fileId: 'file-1'});
		expect(readFileLink(`${ORIGIN}/acme/connections/drive-1?file=file-1`, `${ORIGIN}/`)).toEqual({
			org: 'acme',
			connectionId: 'drive-1',
			fileId: 'file-1',
		});
		// A link within the app, as the page has it, is read against its origin.
		expect(readFileLink('/acme/connections/drive-1?file=file-1', ORIGIN)).toEqual({
			org: 'acme',
			connectionId: 'drive-1',
			fileId: 'file-1',
		});
	});

	test('reads no file from a link elsewhere, a folder’s, another page’s or no link at all', () => {
		expect(
			readFileLink('https://elsewhere.example.com/acme/connections/drive-1?file=file-1', ORIGIN),
		).toBeNull();
		expect(
			readFileLink('http://app.example.com/acme/connections/drive-1?file=file-1', ORIGIN),
		).toBeNull();
		expect(readFileLink(`${ORIGIN}/acme/connections/drive-1?folder=folder-1`, ORIGIN)).toBeNull();
		expect(readFileLink(`${ORIGIN}/acme/agents/drive-1?file=file-1`, ORIGIN)).toBeNull();
		expect(readFileLink(`${ORIGIN}/acme/connections/drive-1/more?file=file-1`, ORIGIN)).toBeNull();
		expect(readFileLink('http://[nonsense', ORIGIN)).toBeNull();
	});
});

describe('markdownImages', () => {
	test('lists the addresses of the pictures shown, and none of a link', () => {
		const text = [
			'Here is the chart: ![Revenue by month](https://app.example.com/acme/connections/d?file=f1)',
			'and [the sheet](https://app.example.com/acme/connections/d?file=f2),',
			'![](<https://app.example.com/acme/connections/d?file=f3> "Title") and ![x]( https://cdn.example.com/a.png ).',
		].join('\n');
		expect(markdownImages(text)).toEqual([
			'https://app.example.com/acme/connections/d?file=f1',
			'https://app.example.com/acme/connections/d?file=f3',
			'https://cdn.example.com/a.png',
		]);
		expect(markdownImages('No pictures here.')).toEqual([]);
	});
});
