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

	test('opens every model under the harness it runs on, with whose account that is, the one chosen checked', async () => {
		open({harness: 'proxy', chatModel: 'glm'});

		const groups = await screen.findAllByRole('group');
		const [openRouter, claude] = groups.filter(
			(group) =>
				group.querySelector('[role="menuitemradio"]') !== null &&
				group.getAttribute('data-slot') === 'dropdown-menu-group',
		);
		if (!openRouter || !claude) {
			throw new Error('expected a group for each harness');
		}
		expect(
			within(openRouter).getByText('Runs on the server’s key, for every member alike.'),
		).toBeTruthy();
		expect(
			within(openRouter)
				.getAllByRole('menuitemradio')
				.map((item) => item.textContent),
		).toEqual(['Claude Sonnet 5.5', 'GLM 5.3']);
		expect(within(claude).getByText('Runs on each member’s own Claude account.')).toBeTruthy();
		expect(
			within(claude)
				.getAllByRole('menuitemradio')
				.map((item) => item.textContent),
		).toEqual(['Claude Sonnet 5.5', 'Claude Opus 5.5', 'Claude Fable 5.2']);
		const checked = screen
			.getAllByRole('menuitemradio')
			.filter((item) => item.getAttribute('aria-checked') === 'true');
		expect(checked.map((item) => item.textContent)).toEqual(['GLM 5.3']);
	});

	test('picking a model picks its harness with it, and closes the list', async () => {
		const onPick = open({harness: 'proxy', chatModel: 'claude'});

		fireEvent.click(await screen.findByRole('menuitemradio', {name: 'Claude Fable 5.2'}));

		expect(onPick).toHaveBeenCalledWith({harness: 'claude-agent-sdk', chatModel: 'fable'});
		// The list closes on a pick, as a switcher's does.
		await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull());
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
