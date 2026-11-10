/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {ChatHarness} from '@proxy/contracts/harness';
import {PersonaDialog} from '@/components/persona-dialog';

afterEach(() => {
	cleanup();
});

// The harnesses a server with both has, as the api lists them.
const harnesses: ChatHarness[] = [
	{
		id: 'proxy',
		label: 'OpenRouter',
		description: 'Runs on the server’s key, for every member alike.',
		models: [
			{id: 'claude', label: 'Claude Sonnet 5.5'},
			{id: 'glm', label: 'GLM 5.3'},
		],
	},
	{
		id: 'claude-agent-sdk',
		label: 'Claude Agent SDK',
		description: 'Runs on each member’s own Claude account.',
		models: [
			{id: 'sonnet', label: 'Claude Sonnet 5.5'},
			{id: 'opus', label: 'Claude Opus 5.5'},
			{id: 'fable', label: 'Claude Fable 5.2'},
		],
	},
];
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

const pressed = (name: string) =>
	screen.getByRole('button', {name}).getAttribute('aria-pressed') === 'true';

describe('PersonaDialog', () => {
	test('creates an agent with Command+Enter', async () => {
		const onClose = mock();
		const onSave = mock(async () => null);
		render(
			<PersonaDialog open initial={null} harnesses={harnesses} onClose={onClose} onSave={onSave} />,
		);

		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Finance'}});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({name: 'Finance'}));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test('makes an agent on the server’s first harness with its first model unless another is picked', async () => {
		const onSave = mock(async () => null);
		render(
			<PersonaDialog
				open
				initial={null}
				harnesses={harnesses}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);

		expect(pressed('OpenRouter')).toBe(true);
		expect(pressed('Claude Sonnet 5.5')).toBe(true);
		expect(screen.getByText('Runs on the server’s key, for every member alike.')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Outreach'}});
		fireEvent.click(screen.getByRole('button', {name: 'Create'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({harness: 'proxy', chatModel: 'claude'}),
		);
	});

	test('switches an agent to another model of its harness', async () => {
		const onSave = mock(async () => null);
		render(
			<PersonaDialog
				open
				initial={{name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'claude'}}
				harnesses={harnesses}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);

		fireEvent.click(screen.getByRole('button', {name: 'GLM 5.3'}));
		expect(pressed('GLM 5.3')).toBe(true);
		fireEvent.click(screen.getByRole('button', {name: 'Save'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({name: 'Finance', harness: 'proxy', chatModel: 'glm'}),
		);
	});

	test('picking another harness offers that harness’s models, starting from its first, with whose account it runs on', async () => {
		const onSave = mock(async () => null);
		render(
			<PersonaDialog
				open
				initial={{name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'glm'}}
				harnesses={harnesses}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);

		fireEvent.click(screen.getByRole('button', {name: 'Claude Agent SDK'}));

		expect(screen.queryByRole('button', {name: 'GLM 5.3'})).toBeNull();
		expect(pressed('Claude Sonnet 5.5')).toBe(true);
		expect(screen.getByText('Runs on each member’s own Claude account.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Claude Fable 5.2'}));
		fireEvent.click(screen.getByRole('button', {name: 'Save'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({harness: 'claude-agent-sdk', chatModel: 'fable'}),
		);
	});

	test('offers nothing to run on where the server has no harness, and sends none', async () => {
		const onSave = mock(async () => null);
		render(<PersonaDialog open initial={null} harnesses={[]} onClose={() => {}} onSave={onSave} />);

		expect(screen.queryByRole('group', {name: 'Harness'})).toBeNull();
		expect(screen.queryByRole('group', {name: 'Model'})).toBeNull();
		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Finance'}});
		fireEvent.click(screen.getByRole('button', {name: 'Create'}));

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({harness: undefined, chatModel: undefined}),
		);
	});
});
