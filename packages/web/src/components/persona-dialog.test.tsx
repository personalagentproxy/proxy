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
		render(
			<PersonaDialog open initial={null} chooseModel={false} onClose={onClose} onSave={onSave} />,
		);

		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Finance'}});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({name: 'Finance'}));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test('offers no model outside an insider organization, and sends none', async () => {
		const onSave = mock(async () => null);
		render(
			<PersonaDialog open initial={null} chooseModel={false} onClose={() => {}} onSave={onSave} />,
		);

		expect(screen.queryByRole('group', {name: 'Model'})).toBeNull();
		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Finance'}});
		fireEvent.click(screen.getByRole('button', {name: 'Create'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({chatModel: undefined}));
	});

	test('switches an agent of an insider organization to another model', async () => {
		const onSave = mock(async () => null);
		const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
		render(
			<PersonaDialog
				open
				initial={{name: 'Finance', look, color: 'blue', chatModel: 'claude'}}
				chooseModel
				onClose={() => {}}
				onSave={onSave}
			/>,
		);

		expect(
			screen.getByRole('button', {name: 'Claude Sonnet 5.5'}).getAttribute('aria-pressed'),
		).toBe('true');
		fireEvent.click(screen.getByRole('button', {name: 'GLM 5.3'}));
		expect(screen.getByRole('button', {name: 'GLM 5.3'}).getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('button', {name: 'Save'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({name: 'Finance', chatModel: 'glm'}),
		);
	});

	test('makes an agent of an insider organization with Claude unless another is picked', async () => {
		const onSave = mock(async () => null);
		render(<PersonaDialog open initial={null} chooseModel onClose={() => {}} onSave={onSave} />);

		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Outreach'}});
		fireEvent.click(screen.getByRole('button', {name: 'Create'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({chatModel: 'claude'}));
	});
});
