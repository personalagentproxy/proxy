import {cleanup, fireEvent, render} from '@testing-library/react';
import {afterEach, describe, expect, test} from 'bun:test';

import {type ImageOf, Markdown} from './markdown';

afterEach(cleanup);

describe('Markdown', () => {
	test('shows a decorative favicon before absolute HTTPS links', () => {
		const {container} = render(
			<Markdown text="Read [the secure example](https://www.example.com/a-page?part=one) or [another page](https://plain.example.com/another-page)." />,
		);
		const links = container.querySelectorAll('a');
		const favicons = container.querySelectorAll('img');

		expect(favicons).toHaveLength(2);
		expect(favicons[0]?.getAttribute('src')).toBe('/api/favicons/www.example.com');
		expect(favicons[1]?.getAttribute('src')).toBe('/api/favicons/plain.example.com');
		expect(favicons[0]?.getAttribute('alt')).toBe('');
		expect(favicons[0]?.getAttribute('loading')).toBe('lazy');
		expect(links[0]?.firstElementChild).toBe(favicons[0]);
	});

	test('leaves relative, email and insecure links without a favicon', () => {
		const {container} = render(
			<Markdown text="[Email us](mailto:hello@example.com), [open settings](/settings), [use HTTP](http://example.com), or use malformed HTTPS links such as [one slash](https:/example.com) and [no slashes](https:example.com)." />,
		);

		expect(container.querySelectorAll('a')).toHaveLength(5);
		expect(container.querySelector('img')).toBeNull();
	});

	test('hides a favicon that cannot be loaded', () => {
		const {container, rerender} = render(<Markdown text="[Example](https://example.com)" />);
		const favicon = container.querySelector('img');

		expect(favicon).not.toBeNull();
		fireEvent.error(favicon as HTMLImageElement);
		expect(favicon?.hidden).toBe(true);

		rerender(<Markdown text="[Example](https://example.com) with more detail" />);
		expect(container.querySelector('img')).toBe(favicon);
		expect(favicon?.hidden).toBe(true);
	});

	test('limits one reply to eight distinct favicon hosts', () => {
		const firstEight = Array.from(
			{length: 8},
			(_, index) => `[Site ${index + 1}](https://site-${index + 1}.example.com)`,
		).join(' ');
		const links = `${firstEight} [Site 1 again](https://site-1.example.com/again) [Site 9](https://site-9.example.com)`;
		const {container} = render(<Markdown text={links} />);

		expect(container.querySelectorAll('a')).toHaveLength(10);
		expect(container.querySelectorAll('img')).toHaveLength(9);
		expect(container.querySelector('a:last-of-type img')).toBeNull();
	});

	// Every picture as an img, its tile-ness in a data attribute, so the tests can tell how it was asked for.
	const image: ImageOf = (src, alt, tile) => <img src={src} alt={alt} data-tile={tile} />;

	test('gathers pictures one after another into a gallery of tiles', () => {
		const text = [
			'Here they are:',
			'![one](a.png)',
			'![two](b.png)  \n![three](c.png) ![four](d.png)',
			'![five](e.png)',
			'That is all.',
		].join('\n\n');
		const {container} = render(<Markdown text={text} image={image} />);
		const pictures = container.querySelectorAll('img');

		expect(pictures).toHaveLength(5);
		expect([...pictures].map((picture) => picture.dataset.tile)).toEqual(Array(5).fill('true'));
		expect(pictures[0]?.parentElement?.className).toContain('grid-cols-3');
		expect(pictures[0]?.parentElement?.querySelectorAll('img')).toHaveLength(5);
		expect(container.querySelectorAll('p')).toHaveLength(2);
	});

	test('gathers pictures one after another among words, as an answer cut short leaves them, keeping the words', () => {
		const text = 'Here:\n![one](a.png)\n![two](b.png)\n![three](c.png)\n![four](d.p';
		const {container} = render(<Markdown text={text} image={image} />);
		const pictures = container.querySelectorAll('img');

		expect(pictures).toHaveLength(3);
		expect([...pictures].map((picture) => picture.dataset.tile)).toEqual(['true', 'true', 'true']);
		expect([...container.querySelectorAll('p')].map((words) => words.textContent?.trim())).toEqual([
			'Here:',
			'![four](d.p',
		]);
	});

	test('lays out two or four pictures two to a row', () => {
		const {container} = render(<Markdown text={'![one](a.png)\n\n![two](b.png)'} image={image} />);

		expect(container.querySelector('img')?.parentElement?.className).toContain('grid-cols-2');
	});

	test('leaves a picture on its own, or among words, as it is', () => {
		const {container} = render(
			<Markdown text={'![one](a.png)\n\nBetween.\n\nSee ![two](b.png) here.'} image={image} />,
		);
		const pictures = container.querySelectorAll('img');

		expect([...pictures].map((picture) => picture.dataset.tile)).toEqual(['false', 'false']);
		expect(container.querySelector('.grid')).toBeNull();
	});
});
