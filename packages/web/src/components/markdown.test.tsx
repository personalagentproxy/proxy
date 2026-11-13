import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, test} from 'bun:test';
import {createMemoryRouter, RouterProvider} from 'react-router';

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

	test('opens a card over https links, and over no others', () => {
		const {container} = render(
			<Markdown text="[secure](https://www.example.com/a), [insecure](http://example.com) and [mail](mailto:a@example.com)." />,
		);
		const triggers = container.querySelectorAll('[data-slot="preview-card-trigger"]');
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.getAttribute('href')).toBe('https://www.example.com/a');
		expect(triggers[0]?.getAttribute('target')).toBe('_blank');
	});

	test('leaves email and insecure links without a favicon', () => {
		const {container} = render(
			<Markdown text="[Email us](mailto:hello@example.com), [use HTTP](http://example.com), or use malformed HTTPS links such as [one slash](https:/example.com) and [no slashes](https:example.com)." />,
		);

		expect(container.querySelectorAll('a')).toHaveLength(4);
		expect(container.querySelector('img')).toBeNull();
	});

	test('opens a link into the app in place, without a favicon, the account page kept to the organization', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/:org/*',
					element: (
						<Markdown text="Connect it on the [Account page](/account), or [open settings](/acme/settings)." />
					),
				},
			],
			{initialEntries: ['/acme/chat']},
		);
		const {container} = render(<RouterProvider router={router} />);

		const account = await screen.findByRole('link', {name: 'Account page'});
		expect(account.getAttribute('href')).toBe('/account?org=acme');
		expect(account.getAttribute('target')).toBeNull();
		expect(screen.getByRole('link', {name: 'open settings'}).getAttribute('href')).toBe(
			'/acme/settings',
		);
		expect(container.querySelector('img')).toBeNull();
	});

	test('opens a thread of the app’s Chat given by its whole address in place, as an agent hands one over, and any other page of the app as any address', async () => {
		const origin = window.location.origin;
		const router = createMemoryRouter(
			[
				{
					path: '/:org/*',
					element: (
						<Markdown
							text={`It is in [Pricing review](${origin}/acme/chat/persona-1/threads/thread-1), beside [the file](${origin}/acme/connections/drive-1?file=file-1); not [theirs](https://elsewhere.example.com/acme/chat/persona-1/threads/thread-1).`}
						/>
					),
				},
			],
			{initialEntries: ['/acme/chat/persona-1']},
		);
		render(<RouterProvider router={router} />);

		const thread = await screen.findByRole('link', {name: 'Pricing review'});
		expect(thread.getAttribute('href')).toBe('/acme/chat/persona-1/threads/thread-1');
		expect(thread.getAttribute('target')).toBeNull();
		expect(thread.querySelector('img')).toBeNull();
		expect(screen.getByRole('link', {name: /the file/}).getAttribute('target')).toBe('_blank');
		expect(screen.getByRole('link', {name: /theirs/}).getAttribute('target')).toBe('_blank');
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

	// Every picture as an img, so the tests can tell where it was put.
	const image: ImageOf = (src, alt) => <img src={src} alt={alt} />;
	// The galleries of what was drawn: each a row of pictures, wrapping.
	const galleries = (container: HTMLElement) => [...container.querySelectorAll('.flex-wrap')];

	test('gathers pictures one after another into a gallery, a row of them that wraps', () => {
		const text = [
			'Here they are:',
			'![one](a.png)',
			'![two](b.png)  \n![three](c.png) ![four](d.png)',
			'![five](e.png)',
			'That is all.',
		].join('\n\n');
		const {container} = render(<Markdown text={text} image={image} />);

		expect(container.querySelectorAll('img')).toHaveLength(5);
		const [gallery] = galleries(container);
		expect(galleries(container)).toHaveLength(1);
		expect([...(gallery?.querySelectorAll('img') ?? [])].map((picture) => picture.alt)).toEqual([
			'one',
			'two',
			'three',
			'four',
			'five',
		]);
		expect(container.querySelectorAll('p')).toHaveLength(2);
	});

	test('gathers pictures one after another among words, as an answer cut short leaves them, keeping the words', () => {
		const text = 'Here:\n![one](a.png)\n![two](b.png)\n![three](c.png)\n![four](d.p';
		const {container} = render(<Markdown text={text} image={image} />);

		expect(galleries(container)[0]?.querySelectorAll('img')).toHaveLength(3);
		expect([...container.querySelectorAll('p')].map((words) => words.textContent?.trim())).toEqual([
			'Here:',
			'![four](d.p',
		]);
	});

	test('takes a picture out of the words around it, onto a line of its own', () => {
		const {container} = render(
			<Markdown text={'![one](a.png)\n\nBetween.\n\nSee ![two](b.png) here.'} image={image} />,
		);

		expect(
			galleries(container).map((row) => [...row.querySelectorAll('img')].map((one) => one.alt)),
		).toEqual([['one'], ['two']]);
		expect([...container.querySelectorAll('p')].map((words) => words.textContent?.trim())).toEqual([
			'Between.',
			'See',
			'here.',
		]);
	});
});
