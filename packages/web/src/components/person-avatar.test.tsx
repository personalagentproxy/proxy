/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {PersonAvatar} from '@/components/person-avatar';

afterEach(() => {
	cleanup();
});

describe('PersonAvatar', () => {
	test('shows the Google profile image without sending a referrer', () => {
		const {container} = render(
			<PersonAvatar
				person={{
					name: 'Ada Lovelace',
					email: 'ada@example.com',
					image: 'https://example.com/ada.png',
				}}
			/>,
		);

		const image = container.querySelector('img');
		const avatar = container.querySelector('[data-slot="person-avatar"]');
		expect(image?.getAttribute('src')).toBe('https://example.com/ada.png');
		expect(image?.getAttribute('loading')).toBe('lazy');
		expect(image?.getAttribute('decoding')).toBe('async');
		expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(avatar?.classList).toContain('size-7');
	});

	test('allows a smaller account-control size', () => {
		const {container} = render(
			<PersonAvatar
				person={{name: 'Ada Lovelace', email: 'ada@example.com', image: null}}
				className="size-6"
			/>,
		);

		const avatar = container.querySelector('[data-slot="person-avatar"]');
		expect(avatar?.classList).toContain('size-6');
		expect(avatar?.classList).not.toContain('size-7');
	});

	test('falls back to the first initial without an image or when it fails to load', () => {
		const {container, rerender} = render(
			<PersonAvatar person={{name: null, email: 'person@example.com', image: null}} />,
		);
		expect(screen.getByText('P')).toBeDefined();
		expect(container.querySelector('img')).toBeNull();

		rerender(
			<PersonAvatar
				person={{
					name: 'Ada Lovelace',
					email: 'ada@example.com',
					image: 'https://example.com/broken.png',
				}}
			/>,
		);
		const image = container.querySelector('img');
		expect(image).not.toBeNull();
		if (!image) {
			return;
		}
		fireEvent.error(image);
		expect(screen.getByText('A')).toBeDefined();
		expect(container.querySelector('img')).toBeNull();
	});

	test('uses the email for a blank name and keeps supplementary Unicode intact', () => {
		const {rerender} = render(
			<PersonAvatar person={{name: '   ', email: 'person@example.com', image: null}} />,
		);
		expect(screen.getByText('P')).toBeDefined();

		rerender(<PersonAvatar person={{name: '👩 Ada', email: 'ada@example.com', image: null}} />);
		expect(screen.getByText('👩')).toBeDefined();
	});
});
