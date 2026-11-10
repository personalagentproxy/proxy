/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import type {ChatHarness} from '@proxy/contracts/harness';
import {ModelSwitcher} from '@/components/model-switcher';

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

function open(chosen: {harness: string; chatModel: string}, onPick = mock()) {
	render(<ModelSwitcher harnesses={harnesses} chosen={chosen} mayChange onPick={onPick} />);
	fireEvent.click(screen.getByRole('button', {name: /^Model:/}));
	return onPick;
}

describe('ModelSwitcher', () => {
	test('says the model and the harness that run the agent', () => {
		render(
			<ModelSwitcher
				harnesses={harnesses}
				chosen={{harness: 'claude-agent-sdk', chatModel: 'opus'}}
				mayChange
				onPick={() => {}}
			/>,
		);

		const trigger = screen.getByRole('button', {
			name: 'Model: Claude Opus 5.5 on Claude Agent SDK',
		});
		expect(trigger.textContent).toBe('Claude Opus 5.5Claude Agent SDK');
	});

	test('opens in two columns: the harnesses down the side, each by its mark, and the models of the agent’s own beside them, with whose account it runs on, the one chosen checked', async () => {
		open({harness: 'proxy', chatModel: 'glm'});

		const side = await screen.findByRole('group', {name: 'Harness'});
		const marks = within(side).getAllByRole('menuitem');
		expect(
			marks.map((mark) => [mark.getAttribute('aria-label'), mark.getAttribute('aria-current')]),
		).toEqual([
			['OpenRouter', 'true'],
			['Claude Agent SDK', 'false'],
		]);
		expect(marks.map((mark) => mark.querySelector('img')?.getAttribute('src'))).toEqual([
			'/harnesses/openrouter.svg',
			'/agent-providers/claude.png',
		]);
		expect(screen.getByText('Runs on the server’s key, for every member alike.')).toBeTruthy();
		const models = screen.getAllByRole('menuitemradio');
		expect(models.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
			['Claude Sonnet 5.5', 'false'],
			['GLM 5.3', 'true'],
		]);
	});

	test('looking at another harness lists its models, none checked, and changes nothing until one is picked, which takes its harness with it and closes the list', async () => {
		const onPick = open({harness: 'proxy', chatModel: 'claude'});

		fireEvent.click(await screen.findByRole('menuitem', {name: 'Claude Agent SDK'}));

		expect(screen.getByText('Runs on each member’s own Claude account.')).toBeTruthy();
		const models = screen.getAllByRole('menuitemradio');
		expect(models.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
			['Claude Sonnet 5.5', 'false'],
			['Claude Opus 5.5', 'false'],
			['Claude Fable 5.2', 'false'],
		]);
		expect(onPick).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('menuitemradio', {name: 'Claude Fable 5.2'}));

		expect(onPick).toHaveBeenCalledWith({harness: 'claude-agent-sdk', chatModel: 'fable'});
		await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull());
	});

	test('opens on the agent’s own harness again after another was looked at', async () => {
		// The pick goes nowhere here, so the agent stays on OpenRouter once the list has closed.
		open({harness: 'proxy', chatModel: 'claude'});
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Claude Agent SDK'}));
		fireEvent.click(screen.getByRole('menuitemradio', {name: 'Claude Opus 5.5'}));
		await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull());

		fireEvent.click(screen.getByRole('button', {name: /^Model:/}));

		const models = await screen.findAllByRole('menuitemradio');
		expect(models.map((item) => item.textContent)).toEqual(['Claude Sonnet 5.5', 'GLM 5.3']);
	});

	test('only says what runs the agent to someone who may not change it', () => {
		render(
			<ModelSwitcher
				harnesses={harnesses}
				chosen={{harness: 'proxy', chatModel: 'claude'}}
				mayChange={false}
				onPick={() => {}}
			/>,
		);

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.getByText('Claude Sonnet 5.5')).toBeTruthy();
		expect(screen.getByText('OpenRouter')).toBeTruthy();
	});

	test('shows what runs it here where the agent was set to a harness or a model the server hasn’t got, and nothing where the server has no harness', () => {
		const {unmount} = render(
			<ModelSwitcher
				harnesses={harnesses.slice(0, 1)}
				chosen={{harness: 'claude-agent-sdk', chatModel: 'opus'}}
				mayChange
				onPick={() => {}}
			/>,
		);
		expect(
			screen.getByRole('button', {name: 'Model: Claude Sonnet 5.5 on OpenRouter'}),
		).toBeTruthy();
		unmount();

		const {container} = render(
			<ModelSwitcher
				harnesses={[]}
				chosen={{harness: 'proxy', chatModel: 'claude'}}
				mayChange
				onPick={() => {}}
			/>,
		);
		expect(container.textContent).toBe('');
	});
});
