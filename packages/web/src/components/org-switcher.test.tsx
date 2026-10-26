/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {OrgTile} from '@/components/org-switcher';

afterEach(() => {
	cleanup();
});

describe('OrgTile', () => {
	test('keeps its contrasting foreground inside interactive parents', () => {
		render(<OrgTile org={{name: 'Acme'}} />);

		const tile = screen.getByText('A');
		expect(tile.hasAttribute('data-preserve-color')).toBe(true);
		expect(tile.classList).toContain('text-primary-foreground');
	});
});
