/// <reference types="bun" />

import type {ChatPersona, ThreadLog} from '@proxy/contracts/harness';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {ChatPage} from '@/pages/chat-page';
import {testHuman} from '@/test-org';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, name: string, mayChange: boolean): ChatPersona {
	return {id, name, mayChange, look, color: 'blue', lastMessage: null};
}

const general = persona('general', 'General', false);
const finance = persona('finance', 'Finance', true);
const log: ThreadLog = {persona: general, entries: [], busy: false, sleepingUntil: null};

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(() => Promise.resolve(new Response(null, {status: 204})));
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
});

function renderChatPage() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/chat/:id',
						loader: ({params}) => ({
							log: {...log, persona: params.id === finance.id ? finance : general},
							personas: [general, finance],
						}),
						element: <ChatPage />,
					},
				],
			},
		],
		{initialEntries: ['/acme/chat/general']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('ChatPage', () => {
	test('lets each agent head follow the pointer only while that agent row is hovered', async () => {
		const {container} = renderChatPage();

		await waitFor(() => {
			expect(container.querySelectorAll('[data-slot="live-head"]')).toHaveLength(2);
		});
		const heads = [...container.querySelectorAll('[data-slot="live-head"]')];
		expect(heads).toHaveLength(2);
		expect(heads.every((head) => head.getAttribute('data-state') === 'rest')).toBe(true);
		const [firstHead, secondHead] = heads;
		if (!firstHead || !secondHead) {
			throw new Error('Expected two agent heads');
		}
		const secondRow = secondHead.closest('a');
		if (!secondRow) {
			throw new Error('Expected the agent head inside its row');
		}

		fireEvent.pointerEnter(secondRow);
		expect(firstHead.getAttribute('data-state')).toBe('rest');
		expect(secondHead.getAttribute('data-state')).toBe('watching');

		fireEvent.pointerLeave(secondRow);
		expect(secondHead.getAttribute('data-state')).toBe('rest');
	});

	test('keeps a hovered head in place when its chat opens', async () => {
		const {container} = renderChatPage();

		await waitFor(() => {
			expect(container.querySelectorAll('[data-slot="live-head"]')).toHaveLength(2);
		});
		const secondHead = container.querySelectorAll('[data-slot="live-head"]')[1];
		const secondRow = secondHead?.closest('a');
		if (!secondHead || !secondRow) {
			throw new Error('Expected the second agent head inside its row');
		}

		fireEvent.pointerEnter(secondRow);
		expect(secondHead.getAttribute('data-state')).toBe('watching');
		fireEvent.pointerUp(secondRow, {pointerType: 'mouse', button: 0});
		fireEvent.click(secondRow);

		await waitFor(() => {
			const openedHead = container.querySelectorAll('[data-slot="live-head"]')[1];
			expect(openedHead?.closest('a')?.getAttribute('aria-current')).toBe('page');
			expect(openedHead?.getAttribute('data-state')).toBe('watching');
		});
	});

	test('does not make a keyboard-opened agent head watch an unrelated pointer', async () => {
		const {container} = renderChatPage();
		const financeRow = await screen.findByRole('link', {name: /Finance/});

		fireEvent.click(financeRow, {detail: 0});

		await waitFor(() => {
			const openedHead = container.querySelectorAll('[data-slot="live-head"]')[1];
			expect(openedHead?.closest('a')?.getAttribute('aria-current')).toBe('page');
			expect(openedHead?.getAttribute('data-state')).toBe('rest');
		});
	});

	test('does not transfer a hover that ended before the next chat opened', async () => {
		const {container} = renderChatPage();
		const financeRow = await screen.findByRole('link', {name: /Finance/});

		fireEvent.pointerEnter(financeRow);
		fireEvent.pointerUp(financeRow, {pointerType: 'mouse', button: 0});
		fireEvent.pointerLeave(financeRow);
		fireEvent.click(financeRow);

		await waitFor(() => {
			const openedHead = container.querySelectorAll('[data-slot="live-head"]')[1];
			expect(openedHead?.closest('a')?.getAttribute('aria-current')).toBe('page');
			expect(openedHead?.getAttribute('data-state')).toBe('rest');
		});
	});

	test('renames a changeable agent from its right-click menu', async () => {
		fetchMock.mockImplementation((_input, init) => {
			if (init?.method === 'PUT') {
				return Promise.resolve(Response.json({persona: {...finance, name: 'Accounting'}}));
			}
			return Promise.resolve(new Response(null, {status: 204}));
		});
		renderChatPage();

		fireEvent.contextMenu(await screen.findByRole('link', {name: /Finance/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Rename'}));
		expect(screen.getByRole('heading', {name: 'Edit agent'})).toBeDefined();
		expect(
			screen.getByText('Its name and its head. The conversation stays as it is.'),
		).toBeDefined();
		fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Accounting'}});
		fireEvent.click(screen.getByRole('button', {name: 'Save'}));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/finance',
				expect.objectContaining({
					method: 'PUT',
					body: JSON.stringify({name: 'Accounting', look, color: 'blue'}),
				}),
			);
		});
	});

	test('deletes a changeable agent from its right-click menu after confirmation', async () => {
		renderChatPage();

		fireEvent.contextMenu(await screen.findByRole('link', {name: /Finance/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Delete'}));

		expect(screen.getByRole('heading', {name: 'Delete Finance?'})).toBeDefined();
		expect(screen.getByText(/every member's conversation/)).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Delete'}));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/finance',
				expect.objectContaining({method: 'DELETE'}),
			);
		});
	});

	test('does not offer deletion for a protected agent', async () => {
		renderChatPage();

		fireEvent.contextMenu(await screen.findByRole('link', {name: /General/}));

		expect(screen.queryByRole('menuitem', {name: 'Rename'})).toBeNull();
		expect(screen.queryByRole('menuitem', {name: 'Delete'})).toBeNull();
	});
});
