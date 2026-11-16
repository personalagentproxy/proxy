/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {PersonaDialog} from '@/components/persona-dialog';

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

	test('says nothing of what runs the agent, which the conversation’s switcher chooses, and sends none', async () => {
		const onSave = mock(async () => null);
		const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
		render(
			<PersonaDialog
				open
				initial={{name: 'Finance', look, color: 'blue'}}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);

		expect(screen.queryByRole('group', {name: 'Model'})).toBeNull();
		expect(screen.queryByRole('group', {name: 'Harness'})).toBeNull();
		fireEvent.click(screen.getByRole('button', {name: 'Save'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith({name: 'Finance', look, color: 'blue'});
	});
	test('creates an explicitly shared team coordinator', async () => {
		const onSave = mock(async () => null);
		render(<PersonaDialog open initial={null} onClose={() => {}} onSave={onSave} />);
		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Coordinator'}});
		fireEvent.change(screen.getByLabelText('Conversation'), {target: {value: 'team'}});
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.click(screen.getByRole('button', {name: 'Create'}));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({name: 'Coordinator', conversationScope: 'team', headAgent: true}),
			),
		);
	});

	test('an existing conversation cannot be made public from the edit dialog', () => {
		const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
		render(
			<PersonaDialog
				open
				initial={{name: 'Finance', look, color: 'blue'}}
				onClose={() => {}}
				onSave={async () => null}
			/>,
		);
		expect(screen.getByLabelText('Conversation').hasAttribute('disabled')).toBe(true);
	});
});
