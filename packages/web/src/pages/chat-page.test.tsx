/// <reference types="bun" />

import type {
	ChatAnswer,
	ChatAttachment,
	ChatPersona,
	ChatThread,
	ChatThreads,
	ThreadMessage,
	ThreadView,
} from '@proxy/contracts/harness';
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
import {THREAD_ROUTE} from '@/pages/chat-thread';
import {FROM_COMMAND_BAR} from '@/lib/command-bar';
import {later} from '@/lib/loader-utils';
import {shouldRevalidateChat} from '@/loaders';
import {testHuman, testOrg} from '@/test-org';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, name: string, mayChange: boolean): ChatPersona {
	return {
		id,
		name,
		shared: false,
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

// A thread of General's chat, as the chat lists it: one the person opened, stopped, unless a test
// says otherwise.
function thread(id: string, over: Partial<ChatThread> = {}): ChatThread {
	return {
		id,
		title: 'Pricing review with Dana',
		state: {kind: 'stopped'},
		standing: 'done',
		standingPending: false,
		opener: {kind: 'person', text: 'Move the pricing review', attachments: []},
		summary: null,
		latest: 'Moved it to Thursday.',
		latestEntryId: 'm2',
		latestAnswerId: 'm2',
		messageCount: 2,
		lastMessageAt: '2026-10-21T10:01:00Z',
		createdAt: '2026-10-21T10:01:00Z',
		...over,
	};
}

// A thread just opened with what the person said, as the api answers its opening.
function opened(text: string, attachments: ChatAttachment[] = []): ChatThread {
	return thread('t-new', {
		title: text,
		state: {kind: 'working'},
		standing: 'in_progress',
		opener: {kind: 'person', text, attachments},
		latest: null,
		latestEntryId: null,
		latestAnswerId: null,
		messageCount: 1,
		lastMessageAt: '2026-10-21T11:00:00Z',
		createdAt: '2026-10-21T11:00:00Z',
	});
}

function said(
	id: string,
	kind: ThreadMessage['kind'],
	text: string,
	attachments: ChatAttachment[] = [],
): ThreadMessage {
	return {id, kind, text, isError: false, at: '2026-10-21T10:00:00Z', attachments};
}

const pricing = thread('t1');
// One an alert opened, at work.
const backup = thread('t2', {
	title: 'Morning check',
	state: {kind: 'working'},
	standing: 'in_progress',
	opener: {kind: 'event', text: 'Every weekday at 9:00, as you asked'},
	latest: null,
	latestEntryId: null,
	latestAnswerId: null,
	messageCount: 1,
	lastMessageAt: '2026-10-21T10:05:00Z',
	createdAt: '2026-10-21T10:05:00Z',
});

// A thread as its page shows it.
function view(listed: ChatThread, messages: ThreadMessage[], busy = false): ThreadView {
	return {persona: general, thread: listed, busy, messages};
}

const pricingView = view(pricing, [
	said('m1', 'person', 'Move the pricing review'),
	said('m2', 'assistant', 'Moved it to **Thursday**.'),
]);

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

// Types into a box as a browser does: what it holds changes, and it says so.
function typeIn(box: HTMLElement, value: string): void {
	box.textContent = value;
	fireEvent.input(box);
}

function renderChatPage({
	personas = [general, finance],
	threads = [],
	listThreads = () => threads,
	listPersonas = () => personas,
	views = {t1: pricingView},
	open = 'general',
	draft = null,
	draftAttachments = [],
	experiments = [],
	answered = () => Promise.resolve(),
	threadAnswered = () => Promise.resolve(),
	initial,
}: {
	personas?: ChatPersona[];
	// The open chat's threads, as the chat is read each time.
	threads?: ChatThread[];
	listThreads?: () => ChatThread[];
	listPersonas?: () => ChatPersona[];
	// Each thread as its page shows it, by its id.
	views?: Record<string, ThreadView>;
	// The agent whose chat is open, by its id.
	open?: string;
	draft?: string | null;
	// The files put in the open chat's box and not sent, as the server keeps them.
	draftAttachments?: ChatThreads['draftAttachments'];
	// What the organization is trying out: Files where a test attaches.
	experiments?: Experiment[];
	// When the api answers for a chat: at once, unless a test holds it back.
	answered?: (personaId: string) => Promise<void>;
	// When the api answers for a thread: at once, unless a test holds it back.
	threadAnswered?: () => Promise<void>;
	// The address the page opens on, where it is not the open chat's, with the history state it
	// came with.
	initial?: string | {pathname: string; state: string};
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
								chat: {
									persona: personas.find((candidate) => candidate.id === params.id) ?? general,
									draft,
									draftAttachments,
									threads: listThreads(),
								},
								personas: listPersonas(),
								harnesses,
							};
						}),
						shouldRevalidate: shouldRevalidateChat,
						element: <ChatPage />,
						children: [
							{
								id: THREAD_ROUTE,
								path: '/:org/chat/:id/threads/:threadId',
								loader: later(async ({params}: {params: {threadId?: string}}) => {
									await threadAnswered();
									return {thread: views[params.threadId ?? ''] ?? null};
								}),
							},
						],
					},
				],
			},
		],
		{initialEntries: [initial ?? `/acme/chat/${open}`]},
	);

	return {
		router,
		...render(
			<ThemeProvider>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</ThemeProvider>,
		),
	};
}

// The heads in the agent rows: each row is a link. The empty chat's own head is beside them, not in one.
function rowHeads(container: HTMLElement): Element[] {
	return [...container.querySelectorAll('a [data-slot="live-head"]')];
}

// Follows a link of the page, and waits for React to have drawn where it leads. A click's own
// `act` ends at once: a render under it that reads the page's answer with `use` and isn't done by
// then is dropped, and React, holding on to it as still to come, never draws that page.
async function follow(link: HTMLElement, init?: MouseEventInit): Promise<void> {
	await act(async () => {
		fireEvent.click(link, init);
	});
}

// The api answering as the rest of the tests have it, and `answer` first where it answers.
function answering(answer: (input: string, init?: RequestInit) => Promise<Response> | null) {
	fetchMock.mockImplementation((input, init) => {
		const answered = answer(input, init);
		if (answered !== null) {
			return answered;
		}
		return Promise.resolve(
			input.endsWith('/chat/answers')
				? Response.json({answers})
				: new Response(null, {status: 204}),
		);
	});
}

describe('ChatPage', () => {
	test('focuses the message input after a conversation is picked from the list', async () => {
		let arrive = () => undefined;
		const held = new Promise<void>((resolve) => {
			arrive = () => {
				resolve();
				return undefined;
			};
		});
		renderChatPage({answered: (personaId) => (personaId === 'finance' ? held : Promise.resolve())});

		const initialBox = await screen.findByLabelText('Message');
		expect(document.activeElement).not.toBe(initialBox);

		await follow(screen.getByRole('link', {name: /Finance/}));
		await screen.findByRole('status', {name: 'Loading'});
		await act(async () => arrive());

		await screen.findByText('What should Finance do?');
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText('Message'));
		});
	});

	test('focuses the message input when the open conversation is picked again', async () => {
		renderChatPage();

		const box = await screen.findByLabelText('Message');
		expect(document.activeElement).not.toBe(box);

		await follow(screen.getByRole('link', {name: /General/}));

		await waitFor(() => {
			expect(document.activeElement).toBe(box);
		});
	});

	test('focuses the message input of a conversation opened from the command bar', async () => {
		renderChatPage({initial: {pathname: '/acme/chat/general', state: FROM_COMMAND_BAR}});

		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText('Message'));
		});
	});

	test('focuses the message input when the command bar goes to another conversation', async () => {
		const {router} = renderChatPage();

		await screen.findByText('What should General do?');
		expect(document.activeElement).not.toBe(screen.getByLabelText('Message'));

		await act(async () => {
			await router.navigate('/acme/chat/finance', {state: FROM_COMMAND_BAR});
		});

		await screen.findByText('What should Finance do?');
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText('Message'));
		});
	});

	test('does not focus or navigate for a modified conversation click', async () => {
		renderChatPage();

		await screen.findByLabelText('Message');
		const financeRow = screen.getByRole('link', {name: /Finance/});
		financeRow.focus();
		fireEvent.click(financeRow, {metaKey: true});

		expect(screen.getByText('What should General do?')).toBeDefined();
		expect(document.activeElement).toBe(financeRow);
	});

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
		await follow(secondRow);

		await waitFor(() => {
			const openedHead = rowHeads(container)[1];
			expect(openedHead?.closest('a')?.getAttribute('aria-current')).toBe('page');
			expect(openedHead?.getAttribute('data-state')).toBe('watching');
		});
	});

	test('does not make a keyboard-opened agent head watch an unrelated pointer', async () => {
		const {container} = renderChatPage();
		const financeRow = await screen.findByRole('link', {name: /Finance/});

		await follow(financeRow, {detail: 0});

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
		await follow(financeRow);

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

		await follow(screen.getByRole('link', {name: /Finance/}));
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
		expect(screen.getByText(/and your conversation with it/)).toBeDefined();
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
		const saidBy = (text: string) => ({
			...finance,
			lastMessage: {kind: 'assistant' as const, text, at: '2026-10-21T10:00:00Z'},
		});
		let listed = [general, saidBy('Old news.')];
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm2', text: 'Moved it to Thursday.'},
				unread: true,
			},
		];
		// The provider asks again once the open chat is read: by then Finance has answered.
		answering((input) => {
			if (input.endsWith('/read')) {
				answers = [
					{
						personaId: 'finance',
						name: 'Finance',
						answer: {id: 'finance-new', text: 'New news.'},
						unread: true,
					},
				];
				listed = [general, saidBy('New news.')];
			}
			return null;
		});
		renderChatPage({threads: [pricing], listPersonas: () => listed});

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

	test('lists the agent last active first, the open one by what was said in it here', async () => {
		answering((input, init) =>
			input.endsWith('/threads') && init?.method === 'POST'
				? Promise.resolve(Response.json({thread: opened('Hi')}))
				: null,
		);
		// Travel was made after Finance last answered; General, open, was made before both.
		const travel = {...persona('travel', 'Travel', true), createdAt: '2026-10-22T10:00:00Z'};
		const answeredFinance = {
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

		renderChatPage({personas: [general, answeredFinance, travel]});
		await screen.findByRole('link', {name: /Travel/});
		expect(order()).toEqual(['Travel', 'Finance', 'General']);

		// What the person says in the open chat puts General on top at once.
		typeIn(screen.getByLabelText('Message'), 'Hi');
		fireEvent.click(screen.getByRole('button', {name: 'Send'}));
		await waitFor(() => expect(order()).toEqual(['General', 'Travel', 'Finance']));
		expect(screen.getByRole('link', {name: /General/}).textContent).toContain('You: Hi');
	});

	test('reads the chat up to the last answer once a thread in it shows it', async () => {
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm2', text: 'Moved it to Thursday.'},
				unread: true,
			},
		];
		renderChatPage({threads: [backup, pricing]});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/general/read',
				expect.objectContaining({method: 'POST', body: JSON.stringify({entryId: 'm2'})}),
			);
		});
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(1);
	});

	test('marks nothing read that the chat does not show', async () => {
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm9', text: 'Something newer.'},
				unread: true,
			},
		];
		renderChatPage({threads: [pricing]});

		await screen.findByRole('link', {name: 'Pricing review with Dana'});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(0);
	});

	test('reads the chat up to an answer a thread in the list shows only once that thread’s row is in view', async () => {
		// A browser that says what is in view: of the rows it is asked about, none, until told.
		const watched: Array<{row: Element; say: (inView: boolean) => void}> = [];
		class Watcher {
			readonly root = null;
			readonly rootMargin = '0px';
			readonly scrollMargin = '0px';
			readonly thresholds = [0];
			private readonly callback: IntersectionObserverCallback;
			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}
			observe(row: Element) {
				const say = (inView: boolean) =>
					this.callback(
						[
							{
								target: row,
								isIntersecting: inView,
								intersectionRatio: inView ? 1 : 0,
								time: 0,
								rootBounds: null,
								boundingClientRect: new DOMRect(),
								intersectionRect: new DOMRect(),
							},
						],
						this,
					);
				watched.push({row, say});
			}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		}
		Object.assign(globalThis, {IntersectionObserver: Watcher});
		const reads = () =>
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read');
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm2', text: 'Moved it to Thursday.'},
				unread: true,
			},
		];
		renderChatPage({threads: [backup, pricing]});

		// The row of the thread that answered is the one asked about; out of view, as while another
		// thread has the page's width, its answer is not read.
		const link = await screen.findByRole('link', {name: 'Pricing review with Dana'});
		await waitFor(() => expect(watched).toHaveLength(1));
		expect(watched[0]?.row.contains(link)).toBe(true);
		act(() => watched[0]?.say(false));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reads()).toHaveLength(0);

		act(() => watched[0]?.say(true));
		await waitFor(() => expect(reads()).toHaveLength(1));
		expect(reads()[0]?.[1]?.body).toBe(JSON.stringify({entryId: 'm2'}));
		Reflect.deleteProperty(globalThis, 'IntersectionObserver');
	});

	test('lists the threads, the one that last had a message last, each with where it stands, what opened it, the start of the latest answer and how many messages it holds', async () => {
		const asleep = thread('t3', {
			title: 'Train tickets',
			state: {kind: 'asleep', until: '2026-10-21T12:00:00Z'},
			standing: 'in_progress',
			opener: {kind: 'person', text: 'Book the train to Porto', attachments: []},
			latest: 'Waiting for the fares to drop.',
			latestEntryId: 'm7',
			latestAnswerId: 'm7',
			messageCount: 1,
			lastMessageAt: '2026-10-21T10:09:00Z',
			createdAt: '2026-10-21T10:09:00Z',
		});
		renderChatPage({threads: [pricing, backup, asleep]});

		const chat = await screen.findByLabelText('Chat');
		const links = within(chat).getAllByRole('link');
		expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
			'Pricing review with Dana',
			'Morning check',
			'Train tickets',
		]);
		expect(links.map((link) => link.getAttribute('href'))).toEqual([
			'/acme/chat/general/threads/t1',
			'/acme/chat/general/threads/t2',
			'/acme/chat/general/threads/t3',
		]);
		const [stopped, working, sleeping] = links.map((link) => link.parentElement as HTMLElement);
		// In progress while at work or asleep; done once stopped needing nothing.
		expect(within(stopped as HTMLElement).queryByText('In progress')).toBeNull();
		expect(within(stopped as HTMLElement).getByText('Done')).toBeTruthy();
		expect(within(working as HTMLElement).getByText('In progress')).toBeTruthy();
		expect(within(sleeping as HTMLElement).getByText('In progress')).toBeTruthy();
		// What the person said, in a bubble; what an alert brought, a line.
		expect(
			within(stopped as HTMLElement)
				.getByText('Move the pricing review')
				.closest('[data-slot=bubble-content]'),
		).toBeTruthy();
		expect(
			within(working as HTMLElement)
				.getByText('Every weekday at 9:00, as you asked')
				.closest('[data-slot=bubble-content]'),
		).toBeNull();
		expect(within(stopped as HTMLElement).getByText('Moved it to Thursday.')).toBeTruthy();
		expect(within(stopped as HTMLElement).getByText(/^2 messages · /)).toBeTruthy();
		expect(within(working as HTMLElement).getByText(/^1 message · /)).toBeTruthy();
	});

	test('reads the chat again while a thread of it is in progress, so one that stops says so', async () => {
		let listed = [backup];
		renderChatPage({listThreads: () => listed});

		const chat = await screen.findByLabelText('Chat');
		expect(within(chat).getByText('In progress')).toBeTruthy();
		listed = [{...backup, state: {kind: 'stopped'}, standing: 'done', latest: 'The backup ran.'}];
		// The chat is read again within the 4 seconds it waits between reads.
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(within(chat).queryByText('In progress')).toBeNull();
		expect(within(chat).getByText('The backup ran.')).toBeTruthy();
	}, 10000);

	test('reads the chat again while where a thread that stopped stands is still being read, so it says it waits for the person once that is written', async () => {
		let listed = [{...pricing, standingPending: true}];
		let reads = 0;
		renderChatPage({
			listThreads: () => {
				reads += 1;
				return listed;
			},
		});

		const chat = await screen.findByLabelText('Chat');
		expect(within(chat).getByText('Done')).toBeTruthy();
		listed = [{...pricing, standing: 'waiting', summary: 'Asks which day suits Dana.'}];
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(within(chat).getByText('Waiting for you')).toBeTruthy();
		expect(within(chat).getByText('Asks which day suits Dana.')).toBeTruthy();

		// Written, there is nothing more to read it again for.
		const read = reads;
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(reads).toBe(read);
	}, 15000);

	test('says a thread waits for the person in orange, one done in ink, and where each stands in a sentence while it is current, the start of the latest answer otherwise', async () => {
		const waiting = thread('t4', {
			title: 'Date filter on the activity log',
			standing: 'waiting',
			opener: {
				kind: 'person',
				text: 'add a date filter to the activity log, plan first',
				attachments: [],
			},
			summary: 'Has a plan, and asks whether the date range should cover the CSV export too.',
			latest: 'I have a plan, and one question before I build.',
			lastMessageAt: '2026-10-21T10:07:00Z',
			createdAt: '2026-10-21T10:07:00Z',
		});
		// Its summary stale, the page has none for it: the start of the latest answer stands in.
		renderChatPage({threads: [pricing, backup, waiting]});

		const chat = await screen.findByLabelText('Chat');
		const [done, working, asking] = within(chat)
			.getAllByRole('link')
			.map((link) => link.parentElement as HTMLElement);
		expect(within(asking as HTMLElement).getByText('Waiting for you').className).toContain(
			'text-waiting',
		);
		expect(
			within(asking as HTMLElement).getByText(
				'Has a plan, and asks whether the date range should cover the CSV export too.',
			),
		).toBeTruthy();
		expect(
			within(asking as HTMLElement).queryByText('I have a plan, and one question before I build.'),
		).toBeNull();
		expect(within(asking as HTMLElement).getByRole('button', {name: 'Mark done'})).toBeTruthy();
		expect(within(done as HTMLElement).getByText('Done').className).toContain('text-foreground');
		expect(within(done as HTMLElement).getByText('Moved it to Thursday.')).toBeTruthy();
		expect(within(done as HTMLElement).queryByRole('button', {name: 'Mark done'})).toBeNull();
		expect(
			within(working as HTMLElement)
				.getByText('In progress')
				.closest('.text-muted-foreground'),
		).toBeTruthy();
		expect(within(working as HTMLElement).queryByRole('button', {name: 'Mark done'})).toBeNull();
	});

	test('marks a thread waiting for the person done from the list, at once and on the server, without opening it', async () => {
		const waiting = thread('t4', {
			standing: 'waiting',
			summary: 'Asks whether Thursday works for Dana.',
		});
		renderChatPage({
			threads: [waiting],
			views: {t4: view(waiting, [said('m1', 'person', 'Move the pricing review')])},
		});

		const chat = await screen.findByLabelText('Chat');
		const button = within(chat).getByRole('button', {name: 'Mark done'});
		await follow(button);

		expect(within(chat).queryByText('Waiting for you')).toBeNull();
		expect(within(chat).getByText('Done')).toBeTruthy();
		expect(within(chat).queryByRole('button', {name: 'Mark done'})).toBeNull();
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						input.endsWith('/chat/personas/general/threads/t4/done') && init?.method === 'POST',
				),
			).toBe(true),
		);
		expect(screen.queryByLabelText('Thread')).toBeNull();
		expect(
			within(chat)
				.getByRole('link', {name: 'Pricing review with Dana'})
				.getAttribute('aria-current'),
		).toBeNull();
	});

	test('where the server can’t be told a thread is done, it waits again, saying why', async () => {
		const waiting = thread('t4', {standing: 'waiting'});
		answering((input) =>
			input.endsWith('/threads/t4/done')
				? Promise.resolve(Response.json({error: 'Something went wrong'}, {status: 500}))
				: null,
		);
		renderChatPage({threads: [waiting]});

		const chat = await screen.findByLabelText('Chat');
		await follow(within(chat).getByRole('button', {name: 'Mark done'}));

		await waitFor(() => expect(within(chat).getByText('Waiting for you')).toBeTruthy());
		expect(within(chat).getByRole('button', {name: 'Mark done'})).toBeTruthy();
		expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
	});

	test('a thread that is done has an archive button where the check is, which takes it out of the list, at once and on the server', async () => {
		const done = thread('t5', {
			title: 'Quarterly numbers',
			standing: 'done',
			summary: 'Sent the numbers.',
		});
		const waiting = thread('t4', {standing: 'waiting'});
		renderChatPage({threads: [done, waiting]});

		const chat = await screen.findByLabelText('Chat');
		// One archive button, on the thread that is done; the one waiting has the check.
		expect(within(chat).getAllByRole('button', {name: 'Archive'})).toHaveLength(1);
		expect(within(chat).getAllByRole('button', {name: 'Mark done'})).toHaveLength(1);

		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		expect(within(chat).queryByRole('link', {name: 'Quarterly numbers'})).toBeNull();
		expect(within(chat).queryByText('Sent the numbers.')).toBeNull();
		expect(within(chat).getByRole('button', {name: 'Mark done'})).toBeTruthy();
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						input.endsWith('/chat/personas/general/threads/t5/archive') && init?.method === 'POST',
				),
			).toBe(true),
		);
	});

	test('a thread marked done can be archived next', async () => {
		const waiting = thread('t4', {standing: 'waiting'});
		renderChatPage({threads: [waiting]});

		const chat = await screen.findByLabelText('Chat');
		await follow(within(chat).getByRole('button', {name: 'Mark done'}));
		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		expect(within(chat).queryByText('Done')).toBeNull();
	});

	test('where the server can’t archive a thread, it is back in the list, saying why', async () => {
		const done = thread('t5', {title: 'Quarterly numbers', standing: 'done'});
		answering((input) =>
			input.endsWith('/threads/t5/archive')
				? Promise.resolve(Response.json({error: 'Something went wrong'}, {status: 500}))
				: null,
		);
		renderChatPage({threads: [done]});

		const chat = await screen.findByLabelText('Chat');
		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		await waitFor(() =>
			expect(within(chat).getByRole('link', {name: 'Quarterly numbers'})).toBeTruthy(),
		);
		expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
	});

	describe('a thread', () => {
		test('done, has an archive button in the title bar, which archives it and closes it', async () => {
			const done = thread('t5', {title: 'Quarterly numbers', standing: 'done'});
			renderChatPage({
				threads: [done],
				views: {t5: view(done, [said('m1', 'person', 'Send me the quarterly numbers')])},
				initial: '/acme/chat/general/threads/t5',
			});

			await screen.findByLabelText('Thread');
			const banner = screen.getByRole('banner');
			await follow(within(banner).getByRole('button', {name: 'Archive'}));

			await waitFor(() => expect(screen.queryByLabelText('Thread')).toBeNull());
			expect(
				within(screen.getByLabelText('Chat')).queryByRole('link', {name: 'Quarterly numbers'}),
			).toBeNull();
			await waitFor(() =>
				expect(
					fetchMock.mock.calls.some(
						([input, init]) => input.endsWith('/threads/t5/archive') && init?.method === 'POST',
					),
				).toBe(true),
			);
		});

		test('archived, slides shut where the person has not asked for less motion, out of reach until it is gone', async () => {
			const motion = mock((query: string) => ({
				matches: query === '(prefers-reduced-motion: no-preference)',
			}));
			Object.assign(globalThis, {matchMedia: motion});
			try {
				const done = thread('t5', {title: 'Quarterly numbers', standing: 'done'});
				renderChatPage({
					threads: [done],
					views: {t5: view(done, [said('m1', 'person', 'Send me the quarterly numbers')])},
					initial: '/acme/chat/general/threads/t5',
				});

				await screen.findByLabelText('Thread');
				await follow(within(screen.getByRole('banner')).getByRole('button', {name: 'Archive'}));

				// Still there as it slides, but out of reach, and no longer the address's.
				const sliding = screen.getByLabelText('Thread').closest('[data-side-slide]');
				expect(sliding?.hasAttribute('inert')).toBe(true);
				expect(document.querySelector('[data-page]')?.hasAttribute('data-side-motion')).toBe(true);
				expect(
					within(screen.getByLabelText('Chat')).queryByRole('link', {name: 'Quarterly numbers'}),
				).toBeNull();

				await waitFor(() => expect(screen.queryByLabelText('Thread') === null).toBe(true));
				expect(document.querySelector('[data-page]')?.hasAttribute('data-side-motion')).toBe(false);
			} finally {
				Reflect.deleteProperty(globalThis, 'matchMedia');
			}
		});

		test('opens beside the chat, named in the title bar, lit in the list, with what was said in it and the box to reply in focused', async () => {
			const answer = view(pricing, [
				said('m1', 'person', 'Move the pricing review'),
				said('m2', 'assistant', 'Moved it to **Thursday**.'),
				said('m3', 'event', 'Every weekday at 9:00, as you asked'),
			]);
			renderChatPage({threads: [pricing, backup], views: {t1: answer}});

			const link = await screen.findByRole('link', {name: 'Pricing review with Dana'});
			await follow(link);

			const opened = await screen.findByLabelText('Thread');
			expect(link.getAttribute('aria-current')).toBe('page');
			expect(
				screen.getByRole('link', {name: 'Morning check'}).getAttribute('aria-current'),
			).toBeNull();
			// Outlined, where it is in the list.
			const listed = within(screen.getByLabelText('Chat'))
				.getByText('Move the pricing review')
				.closest('[data-slot=bubble]');
			expect(listed?.className).toContain('border-border');
			expect(within(screen.getByRole('banner')).getByText('Pricing review with Dana')).toBeTruthy();
			expect(
				within(opened).getByText('Move the pricing review').closest('[data-slot=bubble-content]'),
			).toBeTruthy();
			expect(within(opened).getByText('Thursday').tagName).toBe('STRONG');
			expect(within(opened).getByText('Every weekday at 9:00, as you asked')).toBeTruthy();
			expect(within(opened).queryByText('Working')).toBeNull();
			await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply')));
		});

		test('waiting for the person, says so by its name and has a check beside its name in the title bar, which marks it done in the list and leaves the title bar with its name alone', async () => {
			const waiting = thread('t4', {
				title: 'Date filter on the activity log',
				standing: 'waiting',
				summary: 'Has a plan, and asks whether the date range should cover the CSV export too.',
			});
			renderChatPage({
				threads: [waiting],
				views: {
					t4: view(waiting, [
						said('m1', 'person', 'add a date filter to the activity log, plan first'),
						said(
							'm2',
							'assistant',
							'I have a plan. Should the date range apply to the CSV export too?',
						),
					]),
				},
				initial: '/acme/chat/general/threads/t4',
			});

			const opened = await screen.findByLabelText('Thread');
			const banner = screen.getByRole('banner');
			expect(within(banner).getByText('Waiting for you')).toBeTruthy();
			// A check in the thread's cell of the title bar, not among its messages.
			expect(within(opened).queryByRole('button', {name: 'Mark done'})).toBeNull();
			const button = within(banner).getByRole('button', {name: 'Mark done'});

			await follow(button);

			expect(within(banner).queryByRole('button', {name: 'Mark done'})).toBeNull();
			expect(within(banner).queryByText('Waiting for you')).toBeNull();
			expect(within(banner).queryByText('Done')).toBeNull();
			const chat = screen.getByLabelText('Chat');
			expect(within(chat).queryByText('Waiting for you')).toBeNull();
			expect(within(chat).queryByRole('button', {name: 'Mark done'})).toBeNull();
			await waitFor(() =>
				expect(
					fetchMock.mock.calls.some(
						([input, init]) => input.endsWith('/threads/t4/done') && init?.method === 'POST',
					),
				).toBe(true),
			);
		});

		test('says the agent is at work at its end while it is', async () => {
			renderChatPage({
				threads: [backup],
				views: {
					t2: view(backup, [said('m1', 'event', 'Every weekday at 9:00, as you asked')], true),
				},
				initial: '/acme/chat/general/threads/t2',
			});

			const opened = await screen.findByLabelText('Thread');
			expect(within(opened).getByText('Working')).toBeTruthy();
			expect(within(screen.getByRole('banner')).getByText('In progress')).toBeTruthy();
		});

		test('is named in the title bar at once, while it loads, and the chat stays as it is', async () => {
			let arrive = () => undefined;
			const held = new Promise<void>((resolve) => {
				arrive = () => {
					resolve();
					return undefined;
				};
			});
			renderChatPage({threads: [pricing], threadAnswered: () => held});
			const chat = await screen.findByLabelText('Chat');

			await follow(screen.getByRole('link', {name: 'Pricing review with Dana'}));
			await screen.findByRole('status', {name: 'Loading'});
			expect(within(screen.getByRole('banner')).getByText('Pricing review with Dana')).toBeTruthy();
			expect(screen.getByLabelText('Chat')).toBe(chat);

			await act(async () => arrive());
			await screen.findByLabelText('Thread');
			expect(screen.getByLabelText('Chat')).toBe(chat);
		});

		test('sends a reply to the thread, shown at once, the agent at work under it', async () => {
			const answeredReply: ((response: Response) => void)[] = [];
			answering((input, init) =>
				input.endsWith('/threads/t1/messages') && init?.method === 'POST'
					? new Promise((resolve) => answeredReply.push(resolve))
					: null,
			);
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			const opened = await screen.findByLabelText('Thread');
			const box = screen.getByLabelText('Reply');

			typeIn(box, 'Only mornings');
			fireEvent.click(
				within(box.closest('form') as HTMLElement).getByRole('button', {name: 'Send'}),
			);

			const sent = await within(opened).findByText('Only mornings');
			expect(box.textContent).toBe('');
			expect(within(opened).getByText('Working')).toBeTruthy();
			expect(sent.closest('[data-enter]')?.getAttribute('data-enter')).toBe('rise');
			await waitFor(() => expect(answeredReply).toHaveLength(1));
			const posted = fetchMock.mock.calls.find(([url]) => url.endsWith('/threads/t1/messages'));
			expect(posted?.[0]).toBe('/api/orgs/acme/chat/personas/general/threads/t1/messages');
			expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
				text: 'Only mornings',
				attachments: [],
			});
			await act(async () => {
				answeredReply[0]?.(Response.json({message: said('m4', 'person', 'Only mornings')}));
			});
			expect(within(opened).getByText('Only mornings')).toBe(sent);
			// Nothing of it is kept as the chat's draft.
			expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/draft'))).toEqual([]);
		});

		test('takes the files dropped on the window into its box, uploading each to the thread', async () => {
			const notes = {
				connectionId: 'drive-1',
				fileId: 'file-2',
				version: 'v1',
				name: 'notes.txt',
				type: 'text/plain',
				size: 5,
				shown: false,
				gone: false,
			};
			answering((input, init) =>
				input.includes('/attachments') && init?.method === 'POST'
					? Promise.resolve(Response.json({attachment: notes}))
					: null,
			);
			renderChatPage({
				threads: [pricing],
				experiments: ['files'],
				initial: '/acme/chat/general/threads/t1',
			});
			const box = await screen.findByLabelText('Reply');
			const file = new File(['hello'], 'notes.txt', {type: 'text/plain'});
			fireEvent.drop(window, {dataTransfer: {types: ['Files'], files: [file]}});

			await waitFor(() => expect(box.textContent).toBe('notes.txt '));
			expect(screen.getByLabelText('Message').textContent).toBe('');
			const uploads = fetchMock.mock.calls
				.filter(([url]) => url.includes('/attachments'))
				.map(([url]) => url.split('?')[0]);
			expect(uploads).toEqual(['/api/orgs/acme/chat/personas/general/threads/t1/attachments']);
		});

		test('takes the page’s width and gives it back, and closes back to the chat', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');
			const chatColumn = () => screen.getByLabelText('Chat').closest('[inert]');
			expect(chatColumn()).toBeNull();

			fireEvent.click(screen.getByRole('button', {name: 'Expand'}));
			expect(chatColumn()).not.toBeNull();
			fireEvent.click(screen.getByRole('button', {name: 'Show the chat beside it'}));
			expect(chatColumn()).toBeNull();

			await follow(screen.getByRole('button', {name: 'Close'}));
			await waitFor(() => expect(screen.queryByLabelText('Thread')).toBeNull());
			expect(screen.getByLabelText('Chat')).toBeTruthy();
			expect(
				screen.getByRole('link', {name: 'Pricing review with Dana'}).getAttribute('aria-current'),
			).toBeNull();
		});

		test('Escape gives the chat back beside one with the page’s width, and closes one beside it', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');
			const chatColumn = () => screen.getByLabelText('Chat').closest('[inert]');

			fireEvent.click(screen.getByRole('button', {name: 'Expand'}));
			expect(chatColumn()).not.toBeNull();
			await act(async () => {
				fireEvent.keyDown(document.body, {key: 'Escape'});
			});
			expect(screen.getByLabelText('Thread')).toBeTruthy();
			expect(chatColumn()).toBeNull();

			await act(async () => {
				fireEvent.keyDown(document.body, {key: 'Escape'});
			});
			await waitFor(() => expect(screen.queryByLabelText('Thread') === null).toBe(true));
			expect(screen.getByLabelText('Chat')).toBeTruthy();
		});

		test('Escape leaves one open with a reply typed in its box', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			const box = await screen.findByLabelText('Reply');
			box.focus();
			box.textContent = 'Thursday works';

			await act(async () => {
				fireEvent.keyDown(box, {key: 'Escape'});
			});
			expect(screen.getByLabelText('Thread')).toBeTruthy();

			box.textContent = '';
			await act(async () => {
				fireEvent.keyDown(box, {key: 'Escape'});
			});
			await waitFor(() => expect(screen.queryByLabelText('Thread') === null).toBe(true));
		});

		test('given the page’s width and closed, opens beside the chat again', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');
			const chatColumn = () => screen.getByLabelText('Chat').closest('[inert]');

			fireEvent.click(screen.getByRole('button', {name: 'Expand'}));
			expect(chatColumn()).not.toBeNull();
			await follow(screen.getByRole('button', {name: 'Close'}));
			await waitFor(() => expect(screen.queryByLabelText('Thread')).toBeNull());

			await follow(screen.getByRole('link', {name: 'Pricing review with Dana'}));
			await screen.findByLabelText('Thread');
			expect(chatColumn()).toBeNull();
			expect(screen.getByRole('button', {name: 'Expand'})).toBeTruthy();
		});

		test('says where it is gone, the title bar waiting for no name', async () => {
			const {container} = renderChatPage({threads: [], initial: '/acme/chat/general/threads/t9'});

			expect(await screen.findByText('This thread does not exist anymore.')).toBeTruthy();
			const bar = screen.getByRole('banner');
			await waitFor(() => expect(within(bar).getByText('Thread')).toBeTruthy());
			expect(bar.querySelector('[data-slot="skeleton"]')).toBeNull();
			expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
			expect(within(bar).getByRole('button', {name: 'Close'})).toBeTruthy();
		});

		test('shows the pictures an answer kept where its words put them, any other file it kept as a chip, and loads no picture from anywhere else', async () => {
			const drive = `${window.location.origin}/acme/connections/drive-1`;
			const chart = {
				connectionId: 'drive-1',
				fileId: 'file-1',
				version: 'v2',
				name: 'chart.png',
				type: 'image/png',
				size: 2048,
				shown: true,
				gone: false,
			};
			const sheet = {...chart, fileId: 'file-2', name: 'q3.csv', type: 'text/csv', shown: false};
			renderChatPage({
				threads: [pricing],
				views: {
					t1: view(pricing, [
						said(
							'm1',
							'assistant',
							`Here it is: ![Revenue by month](${drive}?file=file-1), from ![the sheet](${drive}?file=file-2).\n\n![A cat](https://cdn.example.com/cat.png) ![Not kept](${drive}?file=file-3)`,
							[chart, sheet],
						),
					]),
				},
				initial: '/acme/chat/general/threads/t1',
			});

			const picture = await screen.findByRole('img', {name: 'Revenue by month'});
			// The version kept with the answer, as a tile, opening the viewer.
			expect(picture.getAttribute('src')).toBe(
				'/api/orgs/acme/connections/drive-1/files/file-1/content?version=v2',
			);
			expect(picture.className).toContain('object-cover');
			expect(picture.closest('button')).toBeTruthy();
			expect(screen.getByRole('link', {name: 'q3.csv'}).getAttribute('href')).toBe(
				'/acme/connections/drive-1?file=file-2',
			);
			// Anything else is a link, and loads nothing.
			expect(screen.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual([
				'Revenue by month',
			]);
			expect(screen.getByRole('link', {name: 'A cat'}).getAttribute('href')).toBe(
				'https://cdn.example.com/cat.png',
			);
			expect(screen.getByRole('link', {name: 'Not kept'}).getAttribute('href')).toBe(
				`${drive}?file=file-3`,
			);
		});

		test('shows a file deleted for good since as its name alone, struck through, linking nowhere, a picture among them', async () => {
			const drive = `${window.location.origin}/acme/connections/drive-1`;
			const notes = {
				connectionId: 'drive-1',
				fileId: 'file-1',
				version: 'v1',
				name: 'notes.md',
				type: 'text/markdown',
				size: 2048,
				shown: false,
				gone: true,
			};
			const chart = {...notes, fileId: 'file-2', name: 'chart.png', type: 'image/png', shown: true};
			renderChatPage({
				threads: [pricing],
				views: {
					t1: view(pricing, [
						said('m1', 'person', `Read ${ATTACHMENT_MARK}`, [notes]),
						said('m2', 'assistant', `Here: ![Revenue](${drive}?file=file-2)`, [chart]),
					]),
				},
				initial: '/acme/chat/general/threads/t1',
			});

			await screen.findByLabelText('Thread');
			const deleted = await screen.findAllByTitle('notes.md was deleted');
			expect(deleted.every((one) => one.closest('a') === null)).toBe(true);
			expect(screen.getByTitle('chart.png was deleted').closest('a')).toBeNull();
			expect(screen.queryByRole('img', {name: 'Revenue'})).toBeNull();
		});

		test('opens a picture an answer showed in the viewer, whole, and steps through the answer’s pictures there', async () => {
			const drive = `${window.location.origin}/acme/connections/drive-1`;
			const chart = {
				connectionId: 'drive-1',
				fileId: 'file-1',
				version: 'v2',
				name: 'chart.png',
				type: 'image/png',
				size: 2048,
				shown: true,
				gone: false,
			};
			const map = {...chart, fileId: 'file-2', version: 'v1', name: 'map.png'};
			renderChatPage({
				threads: [pricing],
				views: {
					t1: view(pricing, [
						said(
							'm1',
							'assistant',
							`![Revenue](${drive}?file=file-1)\n\n![Stores](${drive}?file=file-2)`,
							[chart, map],
						),
					]),
				},
				initial: '/acme/chat/general/threads/t1',
			});

			fireEvent.click(await screen.findByRole('img', {name: 'Stores'}));

			const viewer = await screen.findByRole('dialog');
			// Under the picture: what the answer said it shows, the file, and where it is among them.
			expect(within(viewer).getByText('map.png · 2 KB · 2 of 2')).toBeTruthy();
			expect(within(viewer).getByRole('link', {name: 'Open in Files'}).getAttribute('href')).toBe(
				'/acme/connections/drive-1?file=file-2',
			);
			const whole = () => within(viewer).getByRole('img');
			expect(whole().getAttribute('alt')).toBe('Stores');
			expect(whole().className).toContain('object-contain');

			// Round from the last to the first, by key and by its arrows.
			fireEvent.keyDown(viewer, {key: 'ArrowRight'});
			expect(whole().getAttribute('alt')).toBe('Revenue');
			expect(within(viewer).getByText('chart.png · 2 KB · 1 of 2')).toBeTruthy();
			fireEvent.click(within(viewer).getByRole('button', {name: 'Previous picture'}));
			expect(whole().getAttribute('alt')).toBe('Stores');

			fireEvent.click(within(viewer).getByRole('button', {name: 'Close'}));
			await waitFor(() => expect(viewer.isConnected).toBe(false));
		});
	});

	describe('sending', () => {
		// The api as it answers the opening of a thread: as `post` says, the rest as before.
		function answerSends(post: () => Promise<Response>) {
			answering((input, init) =>
				input.endsWith('/threads') && init?.method === 'POST' ? post() : null,
			);
		}

		test('opens a thread with what is sent, shown at once at the chat’s end, rising into place, and keeps it as the server answers, without going to it', async () => {
			const answeredOpen: ((response: Response) => void)[] = [];
			answerSends(() => new Promise((resolve) => answeredOpen.push(resolve)));
			renderChatPage({threads: [pricing]});
			const chat = await screen.findByLabelText('Chat');
			const box = screen.getByLabelText('Message');

			typeIn(box, 'Book the train ');
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			const sent = await within(chat).findByText('Book the train');
			expect(box.textContent).toBe('');
			expect(sent.closest('[data-enter]')?.getAttribute('data-enter')).toBe('rise');
			// The server has yet to open it: there is nowhere for it to lead.
			expect(within(sent.closest('[data-enter]') as HTMLElement).queryByRole('link')).toBeNull();
			expect(
				within(sent.closest('[data-enter]') as HTMLElement).getByText('In progress'),
			).toBeTruthy();
			// What was there as the chat opened is simply there.
			expect(within(chat).getByText('Move the pricing review').closest('[data-enter]')).toBeNull();
			// The list has it as the last thing said at once.
			expect(screen.getByRole('link', {name: /General/}).textContent).toContain(
				'You: Book the train',
			);

			await waitFor(() => expect(answeredOpen).toHaveLength(1));
			const posted = fetchMock.mock.calls.find(
				([url, init]) => url.endsWith('/threads') && init?.method === 'POST',
			);
			expect(posted?.[0]).toBe('/api/orgs/acme/chat/personas/general/threads');
			await act(async () => {
				answeredOpen[0]?.(Response.json({thread: opened('Book the train')}));
			});
			expect(within(chat).getByText('Book the train')).toBe(sent);
			expect(screen.queryByLabelText('Thread')).toBeNull();
			// Opened, it leads to the thread the server made, before the chat read again has it.
			expect(
				within(sent.closest('[data-enter]') as HTMLElement)
					.getByRole('link', {name: 'Book the train'})
					.getAttribute('href'),
			).toBe('/acme/chat/general/threads/t-new');
		});

		test('puts what was sent back in the box, and takes it out of the chat, where the send fails', async () => {
			answerSends(() =>
				Promise.resolve(Response.json({error: 'The agent is gone'}, {status: 500})),
			);
			renderChatPage({threads: [pricing]});
			const chat = await screen.findByLabelText('Chat');
			typeIn(screen.getByLabelText('Message'), 'Book the train');
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			// The box is made again, holding what was sent.
			await waitFor(() =>
				expect(screen.getByLabelText('Message').textContent).toBe('Book the train'),
			);
			expect(within(chat).queryByText('Book the train')).toBeNull();
		});
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

			await follow(screen.getByRole('link', {name: /Finance/}));
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
				if (input.endsWith('/threads') && init?.method === 'POST') {
					return Promise.resolve(Response.json({thread: opened('Book the train')}));
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
			gone: false,
		};
		const withFiles: Experiment[] = ['files'];
		// The calls made to the input's files, in order: uploads and removals.
		const calls = () =>
			fetchMock.mock.calls
				.filter(([url]) => url.startsWith(attachmentsUrl))
				.map(([url, init]) => [init?.method, url.slice(attachmentsUrl.length), init?.body]);

		// The chip of a file in the box, by its name: its cross's button, and the chip around it.
		const chipOf = (name: string) => screen.queryByRole('button', {name: `Remove ${name}`});

		test('opens with the files put there before, sends them with the message, and empties the input', async () => {
			fetchMock.mockImplementation((input, init) => {
				if (input.endsWith('/threads') && init?.method === 'POST') {
					return Promise.resolve(Response.json({thread: opened(ATTACHMENT_MARK, [kept])}));
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
			// The list of agents says what is waiting, though nothing is typed.
			await waitFor(() =>
				expect(screen.getByRole('link', {name: /General/}).textContent).toContain(
					'Draft: pricing.md',
				),
			);

			// A file alone is something to send.
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(true));
			expect(box.textContent).toBe('');
			const sent = fetchMock.mock.calls.find(([url]) => url.endsWith('/threads'));
			expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
				text: ATTACHMENT_MARK,
				attachments: [{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'}],
			});
		});

		test('puts the files of a send that failed back in the box where they sat, and takes nothing out on the server', async () => {
			fetchMock.mockImplementation((input, init) => {
				if (input.endsWith('/threads') && init?.method === 'POST') {
					return Promise.resolve(Response.json({error: 'The agent is gone'}, {status: 500}));
				}
				return Promise.resolve(
					input.endsWith('/chat/answers')
						? Response.json({answers})
						: new Response(null, {status: 204}),
				);
			});
			renderChatPage({
				draft: `Read ${ATTACHMENT_MARK}`,
				draftAttachments: [kept],
				experiments: withFiles,
			});
			const chat = await screen.findByLabelText('Chat');
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));

			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() =>
				expect(screen.getByLabelText('Message').textContent).toBe('Read pricing.md '),
			);
			expect(chipOf('pricing.md') === null).toBe(false);
			expect(within(chat).queryByText(/Read/)).toBeNull();
			expect(calls().filter(([method]) => method === 'DELETE')).toEqual([]);
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
				expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/threads'))).toBe(true),
			);
			const sent = fetchMock.mock.calls.find(([url]) => url.endsWith('/threads'));
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

		test('shows the files a thread was opened with where they sat among its words, each a link to the file in its drive; one from before files sat among words has them first', async () => {
			const opener = (text: string) => ({kind: 'person' as const, text, attachments: [kept]});
			renderChatPage({
				threads: [
					thread('t1', {opener: opener(`Compare ${ATTACHMENT_MARK} with last year`)}),
					thread('t2', {title: 'Reading notes', opener: opener('What does this say?')}),
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
