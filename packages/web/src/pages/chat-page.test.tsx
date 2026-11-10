/// <reference types="bun" />

import type {ChatAnswer, ChatPersona, ThreadLog} from '@proxy/contracts/harness';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {ChatPage} from '@/pages/chat-page';
import {testHuman, testOrg} from '@/test-org';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, name: string, mayChange: boolean): ChatPersona {
	return {
		id,
		name,
		mayChange,
		look,
		color: 'blue',
		harness: 'proxy',
		chatModel: 'claude',
		lastMessage: null,
	};
}

// The harness the server has for an agent to run on.
const harnesses = [
	{
		id: 'proxy',
		label: 'OpenRouter',
		description: 'Runs on the server’s key, for every member alike.',
		models: [
			{id: 'claude', label: 'Claude Sonnet 5.5'},
			{id: 'glm', label: 'GLM 5.3'},
		],
	},
];

const general = persona('general', 'General', false);
const finance = persona('finance', 'Finance', true);
const log: ThreadLog = {persona: general, entries: [], busy: false, sleepingUntil: null};
// The last answers the provider around the page is given: none, unless a test says otherwise.
let answers: ChatAnswer[] = [];

beforeEach(() => {
	fetchMock.mockReset();
	answers = [];
	// The provider around the page asks for the last answers; the rest lands with nothing.
	fetchMock.mockImplementation((input) =>
		Promise.resolve(
			input.endsWith('/chat/answers')
				? Response.json({answers})
				: new Response(null, {status: 204}),
		),
	);
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
});

function renderChatPage({
	personas = [general, finance],
	entries = [],
	listPersonas = () => personas,
	open = 'general',
}: {
	personas?: ChatPersona[];
	entries?: ThreadLog['entries'];
	listPersonas?: () => ChatPersona[];
	// The agent whose conversation is open, by its id.
	open?: string;
} = {}) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, experiments: ['harness']}),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/chat/:id',
						loader: ({params}) => ({
							log: {
								...log,
								entries,
								persona: personas.find((candidate) => candidate.id === params.id) ?? general,
							},
							personas: listPersonas(),
							harnesses,
						}),
						element: <ChatPage />,
					},
				],
			},
		],
		{initialEntries: [`/acme/chat/${open}`]},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

// The heads in the agent rows: each row is a link. The empty chat's own head is beside them, not in one.
function rowHeads(container: HTMLElement): Element[] {
	return [...container.querySelectorAll('a [data-slot="live-head"]')];
}

describe('ChatPage', () => {
	test('lets the head of an empty chat follow the pointer', async () => {
		const {container} = renderChatPage();

		await screen.findByText('What should General do?');
		const heads = [...container.querySelectorAll('[data-slot="live-head"]')];
		const emptyChatHead = heads.find((head) => head.closest('a') === null);
		expect(emptyChatHead?.getAttribute('data-state')).toBe('watching');
	});

	test('lets each agent head follow the pointer only while that agent row is hovered', async () => {
		const {container} = renderChatPage();

		await waitFor(() => {
			expect(rowHeads(container)).toHaveLength(2);
		});
		const heads = rowHeads(container);
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
			expect(rowHeads(container)).toHaveLength(2);
		});
		const secondHead = rowHeads(container)[1];
		const secondRow = secondHead?.closest('a');
		if (!secondHead || !secondRow) {
			throw new Error('Expected the second agent head inside its row');
		}

		fireEvent.pointerEnter(secondRow);
		expect(secondHead.getAttribute('data-state')).toBe('watching');
		fireEvent.pointerUp(secondRow, {pointerType: 'mouse', button: 0});
		fireEvent.click(secondRow);

		await waitFor(() => {
			const openedHead = rowHeads(container)[1];
			expect(openedHead?.closest('a')?.getAttribute('aria-current')).toBe('page');
			expect(openedHead?.getAttribute('data-state')).toBe('watching');
		});
	});

	test('does not make a keyboard-opened agent head watch an unrelated pointer', async () => {
		const {container} = renderChatPage();
		const financeRow = await screen.findByRole('link', {name: /Finance/});

		fireEvent.click(financeRow, {detail: 0});

		await waitFor(() => {
			const openedHead = rowHeads(container)[1];
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
			const openedHead = rowHeads(container)[1];
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

	test('switches what runs a changeable agent from under the input, keeping its name and head', async () => {
		fetchMock.mockImplementation((_input, init) => {
			if (init?.method === 'PUT') {
				return Promise.resolve(Response.json({persona: {...finance, chatModel: 'glm'}}));
			}
			return Promise.resolve(new Response(null, {status: 204}));
		});
		renderChatPage({open: 'finance'});

		fireEvent.click(
			await screen.findByRole('button', {name: 'Model: Claude Sonnet 5.5 on OpenRouter'}),
		);
		fireEvent.click(await screen.findByRole('menuitemradio', {name: 'GLM 5.3'}));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/finance',
				expect.objectContaining({
					method: 'PUT',
					body: JSON.stringify({
						name: 'Finance',
						look,
						color: 'blue',
						harness: 'proxy',
						chatModel: 'glm',
					}),
				}),
			);
		});
		// Shown at once, before the list is read again.
		expect(screen.getByRole('button', {name: 'Model: GLM 5.3 on OpenRouter'})).toBeDefined();
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

	test('marks the agents with something unread in the list, never the open one', async () => {
		answers = [general, finance].map(({id, name}) => ({
			personaId: id,
			name,
			answer: {id: `${id}-answer`, text: 'Done.'},
			unread: true,
		}));
		renderChatPage();

		const financeRow = await screen.findByRole('link', {name: /Finance/});
		await waitFor(() => {
			expect(within(financeRow).getByRole('status', {name: 'Unread'})).toBeDefined();
		});
		const generalRow = screen.getByRole('link', {name: /General/});
		expect(within(generalRow).queryByRole('status', {name: 'Unread'})).toBeNull();
	});

	test("shows another agent's new answer in its row, not what was said before it", async () => {
		const said = (text: string) => ({
			...finance,
			lastMessage: {kind: 'assistant' as const, text, at: '2026-10-21T10:00:00Z'},
		});
		let listed = [general, said('Old news.')];
		// The provider asks again once the open conversation is read: by then Finance has answered.
		fetchMock.mockImplementation((input) => {
			if (input.endsWith('/read')) {
				answers = [
					{
						personaId: 'finance',
						name: 'Finance',
						answer: {id: 'finance-new', text: 'New news.'},
						unread: true,
					},
				];
				listed = [general, said('New news.')];
			}
			return Promise.resolve(
				input.endsWith('/chat/answers')
					? Response.json({answers})
					: new Response(null, {status: 204}),
			);
		});
		renderChatPage({
			entries: [
				{id: 'e1', kind: 'assistant', text: 'Hello', isError: false, at: '2026-10-21T10:00:01Z'},
			],
			listPersonas: () => listed,
		});

		const financeRow = await screen.findByRole('link', {name: /Finance/});
		expect(within(financeRow).getByText('Old news.')).toBeDefined();
		await waitFor(() => {
			expect(within(financeRow).getByRole('status', {name: 'Unread'})).toBeDefined();
		});
		await waitFor(() => {
			expect(
				within(screen.getByRole('link', {name: /Finance/})).getByText('New news.'),
			).toBeDefined();
		});
	});

	test('reads the conversation up to the last answer it shows, what the person said after it aside', async () => {
		renderChatPage({
			entries: [
				{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00Z'},
				{id: 'e2', kind: 'assistant', text: 'Hello', isError: false, at: '2026-10-21T10:00:01Z'},
				{id: 'e3', kind: 'person', text: 'And?', isError: false, at: '2026-10-21T10:00:02Z'},
			],
		});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/general/read',
				expect.objectContaining({method: 'POST', body: JSON.stringify({entryId: 'e2'})}),
			);
		});
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(1);
	});

	test('marks nothing read before the agent has answered', async () => {
		renderChatPage({
			entries: [{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00Z'}],
		});

		await screen.findByRole('link', {name: /Finance/});
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(0);
	});
});
