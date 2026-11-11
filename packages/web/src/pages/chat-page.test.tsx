/// <reference types="bun" />

import type {ChatAnswer, ChatPersona, ThreadLog} from '@proxy/contracts/harness';
import type {Experiment} from '@proxy/utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {pageSaysSafeToReload} from '@/hooks/use-reload-on-release';
import {ChatPage} from '@/pages/chat-page';
import {later} from '@/lib/loader-utils';
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
		draft: null,
		createdAt: '2026-10-20T10:00:00Z',
	};
}

// The harness the server has for an agent to run on.
const harnesses = [
	{
		id: 'proxy',
		label: 'OpenRouter',
		models: [
			{id: 'claude', label: 'Claude Sonnet 5.5'},
			{id: 'glm', label: 'GLM 5.3'},
		],
	},
];

const general = persona('general', 'General', false);
const finance = persona('finance', 'Finance', true);
const log: ThreadLog = {
	persona: general,
	entries: [],
	busy: false,
	sleepingUntil: null,
	draft: null,
	draftAttachments: [],
};
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

// Types into the message's box as a browser does: what it holds changes, and it says so.
function typeIn(box: HTMLElement, value: string): void {
	box.textContent = value;
	fireEvent.input(box);
}

function renderChatPage({
	personas = [general, finance],
	entries = [],
	listPersonas = () => personas,
	open = 'general',
	draft = null,
	draftAttachments = [],
	experiments = ['harness'],
	answered = () => Promise.resolve(),
}: {
	personas?: ChatPersona[];
	entries?: ThreadLog['entries'];
	listPersonas?: () => ChatPersona[];
	// The agent whose conversation is open, by its id.
	open?: string;
	draft?: string | null;
	// The files put in the open conversation's input and not sent, as the server keeps them.
	draftAttachments?: ThreadLog['draftAttachments'];
	// What the organization is trying out: Chat, and Files where a test attaches.
	experiments?: Experiment[];
	// When the api answers for a conversation: at once, unless a test holds it back.
	answered?: (personaId: string) => Promise<void>;
} = {}) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, experiments}),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/chat/:id',
						loader: later(async ({params}: {params: {id?: string}}) => {
							await answered(params.id ?? '');
							return {
								log: {
									...log,
									entries,
									draft,
									draftAttachments,
									persona: personas.find((candidate) => candidate.id === params.id) ?? general,
								},
								personas: listPersonas(),
								harnesses,
							};
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

	test('opens another conversation at once, lit in the list and named in the header, while it loads', async () => {
		let arrive = () => undefined;
		const held = new Promise<void>((resolve) => {
			arrive = () => {
				resolve();
				return undefined;
			};
		});
		renderChatPage({answered: (personaId) => (personaId === 'finance' ? held : Promise.resolve())});
		await screen.findByText('What should General do?');

		fireEvent.click(screen.getByRole('link', {name: /Finance/}));
		await screen.findByRole('status', {name: 'Loading'});
		expect(screen.getByRole('link', {name: /Finance/}).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', {name: /General/}).getAttribute('aria-current')).toBeNull();
		expect(screen.getByRole('banner').textContent).toContain('Finance');
		expect(screen.queryByText('What should General do?')).toBeNull();

		await act(async () => arrive());
		expect(await screen.findByText('What should Finance do?')).toBeDefined();
		expect(screen.queryByRole('status', {name: 'Loading'})).toBeNull();
	});

	test('edits a changeable agent from its right-click menu', async () => {
		fetchMock.mockImplementation((_input, init) => {
			if (init?.method === 'PUT') {
				return Promise.resolve(Response.json({persona: {...finance, name: 'Accounting'}}));
			}
			return Promise.resolve(new Response(null, {status: 204}));
		});
		renderChatPage();

		fireEvent.contextMenu(await screen.findByRole('link', {name: /Finance/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Edit'}));
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

		expect(screen.queryByRole('menuitem', {name: 'Edit'})).toBeNull();
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
				{
					id: 'e1',
					kind: 'assistant',
					text: 'Hello',
					isError: false,
					at: '2026-10-21T10:00:01Z',
					attachments: [],
				},
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

	test('lists the agent last active first, the open one by its conversation', async () => {
		// Travel was made after Finance last answered; General, open, was made before both.
		const travel = {...persona('travel', 'Travel', true), createdAt: '2026-10-22T10:00:00Z'};
		const answered = {
			...finance,
			lastMessage: {kind: 'assistant' as const, text: 'Paid.', at: '2026-10-21T10:00:00Z'},
		};
		const order = () =>
			screen
				.getAllByRole('link')
				.map((row) =>
					['General', 'Finance', 'Travel'].find((name) => row.textContent?.includes(name)),
				)
				.filter((name) => name !== undefined);

		renderChatPage({personas: [general, answered, travel]});
		await screen.findByRole('link', {name: /Travel/});
		expect(order()).toEqual(['Travel', 'Finance', 'General']);
		cleanup();

		// What the person said in the open conversation since puts General on top.
		renderChatPage({
			personas: [general, answered, travel],
			entries: [
				{
					id: 'e1',
					kind: 'person',
					text: 'Hi',
					isError: false,
					at: '2026-10-23T10:00:00Z',
					attachments: [],
				},
			],
		});
		await screen.findByRole('link', {name: /Travel/});
		expect(order()).toEqual(['General', 'Travel', 'Finance']);
	});

	test('reads the conversation up to the last answer it shows, what the person said after it aside', async () => {
		renderChatPage({
			entries: [
				{
					id: 'e1',
					kind: 'person',
					text: 'Hi',
					isError: false,
					at: '2026-10-21T10:00:00Z',
					attachments: [],
				},
				{
					id: 'e2',
					kind: 'assistant',
					text: 'Hello',
					isError: false,
					at: '2026-10-21T10:00:01Z',
					attachments: [],
				},
				{
					id: 'e3',
					kind: 'person',
					text: 'And?',
					isError: false,
					at: '2026-10-21T10:00:02Z',
					attachments: [],
				},
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
			entries: [
				{
					id: 'e1',
					kind: 'person',
					text: 'Hi',
					isError: false,
					at: '2026-10-21T10:00:00Z',
					attachments: [],
				},
			],
		});

		await screen.findByRole('link', {name: /Finance/});
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(0);
	});

	describe('drafts', () => {
		const draftUrl = '/api/orgs/acme/chat/personas/general/draft';
		// The drafts saved, in order.
		const saves = () =>
			fetchMock.mock.calls
				.filter(([url, init]) => url === draftUrl && init?.method === 'PUT')
				.map(([, init]) => JSON.parse(String(init?.body)) as {text: string});

		test('opens with what was typed and not sent, safe to reload', async () => {
			renderChatPage({draft: 'Move the pricing review'});

			const box = await screen.findByLabelText('Message');
			expect(box.textContent).toBe('Move the pricing review');
			expect(pageSaysSafeToReload()).toBe(true);
			expect(saves()).toEqual([]);
		});

		test('saves what is typed a moment after the typing stops, once', async () => {
			renderChatPage();
			const box = await screen.findByLabelText('Message');

			typeIn(box, 'Move the');
			typeIn(box, 'Move the pricing review');
			expect(pageSaysSafeToReload()).toBe(false);

			await waitFor(() => expect(saves()).toEqual([{text: 'Move the pricing review'}]), {
				timeout: 2000,
			});
			await waitFor(() => expect(pageSaysSafeToReload()).toBe(true));
		});

		test('saves at once as another conversation opens, and lists it there as a draft', async () => {
			renderChatPage();
			const box = await screen.findByLabelText('Message');
			typeIn(box, 'Move the pricing review');

			fireEvent.click(screen.getByRole('link', {name: /Finance/}));
			await screen.findByText('What should Finance do?');

			expect(saves()).toEqual([{text: 'Move the pricing review'}]);
			const generalRow = screen.getByRole('link', {name: /General/});
			expect(generalRow.textContent).toContain('Draft: Move the pricing review');
		});

		test('lists the open conversation’s draft as it is typed, and another’s as the server keeps it', async () => {
			renderChatPage({personas: [general, {...finance, draft: 'Pay the invoice'}]});
			const box = await screen.findByLabelText('Message');

			expect(screen.getByRole('link', {name: /Finance/}).textContent).toContain(
				'Draft: Pay the invoice',
			);
			expect(screen.getByRole('link', {name: /General/}).textContent).not.toContain('Draft:');

			typeIn(box, 'Book the train');
			expect(screen.getByRole('link', {name: /General/}).textContent).toContain(
				'Draft: Book the train',
			);
		});

		test('sends without saving what was typed for it, and empties the box', async () => {
			fetchMock.mockImplementation((input, init) => {
				if (input.endsWith('/messages') && init?.method === 'POST') {
					return Promise.resolve(
						Response.json({
							entry: {
								id: 'e1',
								kind: 'person',
								text: 'Book the train',
								isError: false,
								at: '2026-10-21T10:00:00Z',
								attachments: [],
							},
						}),
					);
				}
				return Promise.resolve(
					input.endsWith('/chat/answers')
						? Response.json({answers})
						: new Response(null, {status: 204}),
				);
			});
			renderChatPage();
			const box = await screen.findByLabelText('Message');

			typeIn(box, 'Book the train');
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() => expect(box.textContent).toBe(''));
			await new Promise((resolve) => setTimeout(resolve, 900));
			expect(saves()).toEqual([]);
			expect(screen.getByRole('link', {name: /General/}).textContent).not.toContain('Draft:');
		});
	});

	describe('files in the input', () => {
		const attachmentsUrl = '/api/orgs/acme/chat/personas/general/attachments';
		const kept = {
			connectionId: 'drive-1',
			fileId: 'file-1',
			version: 'v1',
			name: 'pricing.md',
			type: 'text/markdown',
			size: 2048,
			shown: false,
		};
		const withFiles: Experiment[] = ['harness', 'files'];
		// The calls made to the input's files, in order: uploads and removals.
		const calls = () =>
			fetchMock.mock.calls
				.filter(([url]) => url.startsWith(attachmentsUrl))
				.map(([url, init]) => [init?.method, url.slice(attachmentsUrl.length), init?.body]);

		// The chip of a file in the box, by its name: its cross's button, and the chip around it.
		const chipOf = (name: string) => screen.queryByRole('button', {name: `Remove ${name}`});

		test('opens with the files put there before, sends them with the message, and empties the input', async () => {
			fetchMock.mockImplementation((input, init) => {
				if (input.endsWith('/messages') && init?.method === 'POST') {
					return Promise.resolve(
						Response.json({
							entry: {
								id: 'e1',
								kind: 'person',
								text: ATTACHMENT_MARK,
								isError: false,
								at: '2026-10-21T10:00:00Z',
								attachments: [kept],
							},
						}),
					);
				}
				return Promise.resolve(
					input.endsWith('/chat/answers')
						? Response.json({answers})
						: new Response(null, {status: 204}),
				);
			});
			renderChatPage({draftAttachments: [kept], experiments: withFiles});

			// A chip by its name in the box the message is typed in, its size said on hover.
			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));
			// With a space after it, so the caret has text to be in.
			expect(box.textContent).toBe('pricing.md ');
			expect(chipOf('pricing.md')?.parentElement?.getAttribute('title')).toBe('pricing.md · 2 KB');
			// The list beside the conversation says what is waiting, though nothing is typed.
			await waitFor(() =>
				expect(screen.getByRole('link', {name: /General/}).textContent).toContain(
					'Draft: pricing.md',
				),
			);

			// A file alone is something to send.
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(true));
			expect(box.textContent).toBe('');
			const sent = fetchMock.mock.calls.find(([url]) => url.endsWith('/messages'));
			expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
				text: ATTACHMENT_MARK,
				attachments: [{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'}],
			});
		});

		test('opens with each file where it sat among the words, and sends the words with a mark for each, in their order', async () => {
			const chart = {...kept, fileId: 'file-2', name: 'chart.png', type: 'image/png'};
			const typed = `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`;
			renderChatPage({draft: typed, draftAttachments: [chart, kept], experiments: withFiles});

			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(box.textContent).toBe('Does chart.png match pricing.md?'));
			// Nothing was typed since it opened, so nothing is saved.
			expect(pageSaysSafeToReload()).toBe(true);

			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() =>
				expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/messages'))).toBe(true),
			);
			const sent = fetchMock.mock.calls.find(([url]) => url.endsWith('/messages'));
			expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
				text: typed,
				attachments: [
					{connectionId: 'drive-1', fileId: 'file-2', version: 'v1'},
					{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'},
				],
			});
		});

		test('gives a file the message ends with a space after it, for the caret to be in, and saves nothing for it', async () => {
			renderChatPage({
				draft: `Look at ${ATTACHMENT_MARK}`,
				draftAttachments: [kept],
				experiments: withFiles,
			});

			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(box.textContent).toBe('Look at pricing.md '));
			expect(box.lastChild?.nodeType).toBe(Node.TEXT_NODE);
			expect(pageSaysSafeToReload()).toBe(true);
		});

		test('marks a file whole where the selection takes it in, and not where it doesn’t', async () => {
			renderChatPage({
				draft: `Look at ${ATTACHMENT_MARK} today`,
				draftAttachments: [kept],
				experiments: withFiles,
			});
			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));
			const place = box.querySelector('[data-file]');

			// Everything, as by selecting all.
			window.getSelection()?.selectAllChildren(box);
			fireEvent(document, new Event('selectionchange'));
			expect(place?.getAttribute('data-selected')).toBe('true');

			// The caret alone, after it.
			window.getSelection()?.collapseToEnd();
			fireEvent(document, new Event('selectionchange'));
			expect(place?.getAttribute('data-selected')).toBe('false');
		});

		test('saves what is typed around a file with which file each mark is', async () => {
			renderChatPage({draftAttachments: [kept], experiments: withFiles});
			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));

			// Typed after the chip and the space it has after it, as a browser adds a word to the box.
			box.append('what does this say?');
			fireEvent.input(box);

			const draftUrl = '/api/orgs/acme/chat/personas/general/draft';
			await waitFor(
				() =>
					expect(
						fetchMock.mock.calls
							.filter(([url, init]) => url === draftUrl && init?.method === 'PUT')
							.map(([, init]) => JSON.parse(String(init?.body)))
							.at(-1),
					).toEqual({
						text: `${ATTACHMENT_MARK} what does this say?`,
						attachments: [{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'}],
					}),
				{timeout: 2000},
			);
		});

		test('takes a file out of the input on the server too, by its cross or by deleting it from the text', async () => {
			const chart = {...kept, fileId: 'file-2', name: 'chart.png', type: 'image/png'};
			renderChatPage({draftAttachments: [kept, chart], experiments: withFiles});
			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));

			fireEvent.click(screen.getByRole('button', {name: 'Remove pricing.md'}));

			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(true));
			expect(calls()).toEqual([
				['DELETE', '', JSON.stringify({connectionId: 'drive-1', fileId: 'file-1', version: 'v1'})],
			]);

			// Backspace over a chip deletes it from the text as one thing: the box then has no place
			// for it, and says it changed.
			chipOf('chart.png')?.closest('[data-file]')?.remove();
			fireEvent.input(box);

			await waitFor(() => expect(calls()).toHaveLength(2));
			expect(calls()[1]).toEqual([
				'DELETE',
				'',
				JSON.stringify({connectionId: 'drive-1', fileId: 'file-2', version: 'v1'}),
			]);
			expect((screen.getByRole('button', {name: 'Send'}) as HTMLButtonElement).disabled).toBe(true);
		});

		test('uploads at once what is dropped anywhere on the window, showing where it will go while it is dragged', async () => {
			fetchMock.mockImplementation((input, init) =>
				Promise.resolve(
					input.startsWith(attachmentsUrl) && init?.method === 'POST'
						? Response.json({attachment: {...kept, fileId: 'file-2', name: 'notes.txt', size: 5}})
						: input.endsWith('/chat/answers')
							? Response.json({answers})
							: new Response(null, {status: 204}),
				),
			);
			renderChatPage({experiments: withFiles});
			const box = await screen.findByLabelText('Message');
			typeIn(box, 'See ');
			const file = new File(['hello'], 'notes.txt', {type: 'text/plain'});
			const dragged = {dataTransfer: {types: ['Files'], files: [file]}};

			fireEvent.dragEnter(window, dragged);
			expect(screen.getByText('Drop files to attach them')).toBeTruthy();
			fireEvent.drop(window, dragged);

			expect(screen.queryByText('Drop files to attach them')).toBeNull();
			// Its chip goes in the box, after what was typed.
			await waitFor(() => expect(box.textContent).toBe('See notes.txt '));
			// The file's name and its type go in the address; its bytes are the body.
			expect(calls()).toHaveLength(1);
			expect(calls()[0]?.slice(0, 2)).toEqual([
				'POST',
				`?${new URLSearchParams({name: 'notes.txt', type: file.type}).toString()}`,
			]);
			expect(calls()[0]?.[2]).toBe(file);
			await waitFor(() =>
				expect((screen.getByRole('button', {name: 'Send'}) as HTMLButtonElement).disabled).toBe(
					false,
				),
			);
		});

		test('shows the files a message was sent with where they sat among its words, each a link to the file in its drive; one from before files sat among words has them first', async () => {
			const entry = {
				kind: 'person' as const,
				isError: false,
				at: '2026-10-21T10:00:00Z',
				attachments: [kept],
			};
			renderChatPage({
				entries: [
					{...entry, id: 'e1', text: `Compare ${ATTACHMENT_MARK} with last year`},
					{...entry, id: 'e2', text: 'What does this say?'},
				],
				experiments: withFiles,
			});

			const [among, first] = await screen.findAllByRole('link', {name: 'pricing.md'});
			expect(among?.getAttribute('href')).toBe('/acme/connections/drive-1?file=file-1');
			expect(among?.getAttribute('title')).toBe('pricing.md · 2 KB');
			expect(among?.closest('[data-slot=bubble-content]')?.textContent).toBe(
				'Compare pricing.md with last year',
			);
			expect(first?.closest('[data-slot=bubble-content]')?.textContent).toBe(
				'pricing.mdWhat does this say?',
			);
		});

		test('takes no files where the organization has none: no paperclip, and a drop is left alone', async () => {
			renderChatPage();
			await screen.findByLabelText('Message');

			fireEvent.dragEnter(window, {dataTransfer: {types: ['Files'], files: []}});

			expect(screen.queryByRole('button', {name: 'Attach files'})).toBeNull();
			expect(screen.queryByText('Drop files to attach them')).toBeNull();
		});
	});
});
