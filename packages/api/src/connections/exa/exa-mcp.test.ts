import {describe, expect, test} from 'bun:test';

import {parseExaPage} from './exa-mcp';

describe('parseExaPage', () => {
	test("reads the title from the heading Exa puts before a page's text", () => {
		const text = '# Mocks | Bun Docs\nURL: https://bun.sh/docs/test/mocks\n\n# Mocks\n\nMocking replaces a dependency.\n';
		expect(parseExaPage(text)).toEqual({title: 'Mocks | Bun Docs', content: '# Mocks\n\nMocking replaces a dependency.'});
	});

	test('keeps all of it as the text when there is no heading', () => {
		expect(parseExaPage('Just text\n')).toEqual({title: '', content: 'Just text'});
	});
});
