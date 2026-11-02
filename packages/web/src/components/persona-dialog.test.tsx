/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';

mock.module('@/components/head', () => ({LiveHead: () => null}));

const {PersonaDialog} = await import('@/components/persona-dialog');

afterEach(() => {
	cleanup();
});

describe('PersonaDialog', () => {
	test('creates an agent with Command+Enter', async () => {
		const onClose = mock();
		const onSave = mock(async () => null);
		render(<PersonaDialog open initial={null} onClose={onClose} onSave={onSave} />);

		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Finance'}});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({name: 'Finance'}));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
