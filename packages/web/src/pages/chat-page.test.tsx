/// <reference types="bun" />

import type {
	ChatAnswer,
	ChatAttachment,
	ChatThread,
	ChatThreads,
	ListedPersona,
	ThreadMessage,
	ThreadView,
} from '@proxy/contracts/harness';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {pageSaysSafeToReload} from '@/hooks/use-reload-on-release';
import {formatAgo} from '@/lib/format';
import {ChatPage} from '@/pages/chat-page';
import {THREAD_ROUTE} from '@/pages/chat-thread';
import {FROM_COMMAND_BAR} from '@/lib/command-bar';
import {later} from '@/lib/loader-utils';
import {chatIndexLoader, shouldRevalidateChat} from '@/loaders';
import {testHuman, testOrg} from '@/test-org';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, name: string, mayChange: boolean): ListedPersona {
	return {
		id,
		name,
		shared: false,
		mayChange,
		madeBy: 'you',
		usedByOthers: false,
		staysShared: null,
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

// General, which the organization's owner made with it, and the person, a member, may not change.
const general = {...persona('general', 'General', false), madeBy: {name: 'Dana'}};
const finance = persona('finance', 'Finance', true);
// Finance in Slack, as the api says it to whoever may change it.
const financeInSlack = {
	workspaces: [{id: 'workspace-1', name: 'Northwind', needsToken: false, inUse: true}],
	app: {
		state: 'in_slack',
		workspaceId: 'workspace-1',
		workspaceName: 'Northwind',
		handle: 'finance',
		settingsUrl: null,
	},
	unavailable: null,
};

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
		messageCount: 2,
		lastMessageAt: '2026-10-21T10:01:00Z',
		createdAt: '2026-10-21T10:01:00Z',
		alerts: 0,
		openedByAlert: false,
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
	openedByAlert: true,
	latest: null,
	latestEntryId: null,
	messageCount: 1,
	lastMessageAt: '2026-10-21T10:05:00Z',
	createdAt: '2026-10-21T10:05:00Z',
});

// A thread as its page shows it.
function view(
	listed: ChatThread,
	messages: ThreadMessage[],
	busy = false,
	draft: string | null = null,
): ThreadView {
	return {
		persona: general,
		thread: listed,
		model: {harness: 'proxy', chatModel: 'claude'},
		busy,
		messages,
		draft,
	};
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
	chatAlerts = 0,
	others = false,
	slack = false,
	answered = () => Promise.resolve(),
	threadAnswered = () => Promise.resolve(),
	initial,
}: {
	personas?: ListedPersona[];
	// The open chat's threads, as the chat is read each time.
	threads?: ChatThread[];
	listThreads?: () => ChatThread[];
	listPersonas?: () => ListedPersona[];
	// Each thread as its page shows it, by its id.
	views?: Record<string, ThreadView>;
	// The agent whose chat is open, by its id.
	open?: string;
	draft?: string | null;
	// The files put in the open chat's box and not sent, as the server keeps them.
	draftAttachments?: ChatThreads['draftAttachments'];
	// How many of the open chat's alerts open threads of their own.
	chatAlerts?: number;
	// Whether anyone else is in the organization.
	others?: boolean;
	// Whether the organization has the `slack` experiment on.
	slack?: boolean;
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
				loader: () => testHuman({...testOrg, memberCount: others ? 3 : 1, slack}),
				element: <HumanSide />,
				children: [
					// Chat's own address, which goes to the first agent the api lists, or, with none,
					// stays with no chat open.
					{path: '/:org/chat', loader: chatIndexLoader, element: <ChatPage />},
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
									alerts: chatAlerts,
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
								children: [{path: '/:org/chat/:id/threads/:threadId/settings'}],
							},
							{path: '/:org/chat/:id/settings'},
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

// What a row of a list that went is while it slides out (hooks/use-list-motion.ts): out of reach,
// and no longer the list's.
const GOING = '[aria-hidden="true"] *, script, style';

// Opens a new task's box, floating over the page, from the button at the foot of the tasks, and
// gives it once it has the keyboard's focus.
async function openNewTask(): Promise<HTMLElement> {
	const tasks = await screen.findByLabelText('Tasks');
	await act(async () => {
		fireEvent.click(
			within(tasks.parentElement as HTMLElement).getByRole('button', {name: /New task/}),
		);
	});
	const box = await screen.findByLabelText('Message');
	await waitFor(() => expect(document.activeElement).toBe(box));
	return box;
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
	test('opens a conversation picked from the list with no new task’s box over it', async () => {
		let arrive = () => undefined;
		const held = new Promise<void>((resolve) => {
			arrive = () => {
				resolve();
				return undefined;
			};
		});
		renderChatPage({answered: (personaId) => (personaId === 'finance' ? held : Promise.resolve())});

		await screen.findByText('What should General do?');
		expect(screen.queryByLabelText('Message')).toBeNull();

		await follow(screen.getByRole('link', {name: /Finance/}));
		await screen.findByRole('status', {name: 'Loading'});
		await act(async () => arrive());

		await screen.findByText('What should Finance do?');
		expect(screen.queryByLabelText('Message')).toBeNull();
	});

	test('opens a new task’s box, focused, over a conversation opened from the command bar', async () => {
		renderChatPage({initial: {pathname: '/acme/chat/general', state: FROM_COMMAND_BAR}});

		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText('Message'));
		});
	});

	test('opens a new task’s box when the command bar goes to another conversation', async () => {
		const {router} = renderChatPage();

		await screen.findByText('What should General do?');
		expect(screen.queryByLabelText('Message')).toBeNull();

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

		await screen.findByText('What should General do?');
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

	test('opens the new agent dialog at the platform’s shortcut with Shift and N, not without Shift', async () => {
		renderChatPage();
		await screen.findByText('What should General do?');
		const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
		const press = (shiftKey: boolean) =>
			act(async () => {
				fireEvent.keyDown(document.body, {
					key: shiftKey ? 'N' : 'n',
					code: 'KeyN',
					metaKey: apple,
					ctrlKey: !apple,
					shiftKey,
				});
			});

		await press(false);
		expect(screen.queryByRole('heading', {name: 'New agent'})).toBeNull();
		// Without Shift, a new task's box; put away, the page is as it was.
		const box = await screen.findByLabelText('Message');
		await act(async () => {
			fireEvent.keyDown(box, {key: 'Escape'});
		});
		await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());

		await press(true);
		expect(await screen.findByRole('heading', {name: 'New agent'})).toBeDefined();
	});

	test('shows no shortcut on New task or New agent in a browser, which keeps them for its windows', async () => {
		renderChatPage();
		await screen.findByText('What should General do?');

		for (const button of screen.getAllByRole('button', {name: /New (task|agent)/})) {
			expect(button.textContent).toMatch(/^New (task|agent)$/);
		}
	});

	test('switches what runs a changeable agent from under the input, keeping its name and head', async () => {
		fetchMock.mockImplementation((_input, init) => {
			if (init?.method === 'PUT') {
				return Promise.resolve(Response.json({persona: {...finance, chatModel: 'glm'}}));
			}
			return Promise.resolve(new Response(null, {status: 204}));
		});
		renderChatPage({open: 'finance'});
		await openNewTask();

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

	test('deleting the last agent, the open one, leaves Chat with none: the list says so, and the page offers to make one', async () => {
		let listed: ListedPersona[] = [finance];
		answering((input, init) => {
			if (input === '/api/orgs/acme/chat/personas' && (init?.method ?? 'GET') === 'GET') {
				return Promise.resolve(Response.json({personas: listed, harnesses}));
			}
			if (init?.method === 'DELETE') {
				listed = [];
			}
			return null;
		});
		const {router} = renderChatPage({
			personas: [finance],
			open: 'finance',
			listPersonas: () => listed,
		});

		fireEvent.contextMenu(await screen.findByRole('link', {name: /Finance/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Delete'}));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', {name: 'Delete'}));
		});

		await waitFor(() => expect(router.state.location.pathname).toBe('/acme/chat'));
		expect(await screen.findByText('No agents yet')).toBeDefined();
		expect(screen.getByText('No agents yet.')).toBeDefined();
		expect(screen.queryByRole('link', {name: /Finance/})).toBeNull();
		expect(screen.queryByLabelText('Tasks')).toBeNull();

		// The page's own New agent, beside the list's, opens the dialog that makes one.
		const buttons = screen.getAllByRole('button', {name: /New agent/});
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[1] as HTMLElement);
		expect(screen.getByRole('heading', {name: 'New agent'})).toBeDefined();
	});

	test('Chat’s own address goes to the first agent listed, where there is one', async () => {
		answering((input) =>
			input === '/api/orgs/acme/chat/personas'
				? Promise.resolve(Response.json({personas: [finance, general], harnesses}))
				: null,
		);
		const {router} = renderChatPage({initial: '/acme/chat'});

		await waitFor(() => expect(router.state.location.pathname).toBe('/acme/chat/finance'));
		expect(await screen.findByText('What should Finance do?')).toBeDefined();
	});

	test('marks a shared agent beside its name once anyone else is in the organization, and not while the person is alone in it', async () => {
		const travel = {...persona('travel', 'Travel', true), shared: true};
		renderChatPage({personas: [{...general, shared: true}, finance, travel], others: true});

		const row = await screen.findByRole('link', {name: /Travel/});
		expect(within(row).getByRole('img', {name: 'Everyone in Acme'})).toBeDefined();
		expect(
			within(screen.getByRole('link', {name: /Finance/})).queryByRole('img', {
				name: 'Everyone in Acme',
			}),
		).toBeNull();
		cleanup();

		renderChatPage({personas: [{...general, shared: true}, finance, travel]});
		const alone = await screen.findByRole('link', {name: /Travel/});
		expect(within(alone).queryByRole('img', {name: 'Everyone in Acme'})).toBeNull();
	});

	test('says deleting a shared agent others have talked to deletes their conversations with it too', async () => {
		const travel = {...persona('travel', 'Travel', true), shared: true, usedByOthers: true};
		renderChatPage({personas: [general, finance, travel], others: true});

		fireEvent.contextMenu(await screen.findByRole('link', {name: /Travel/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Delete'}));

		expect(screen.getByText(/every member's conversation with it, not only yours/)).toBeDefined();
	});

	test('offers an agent the person may not change its settings alone in its right-click menu', async () => {
		renderChatPage();

		fireEvent.contextMenu(await screen.findByRole('link', {name: /General/}));

		expect(await screen.findByRole('menuitem', {name: 'Settings'})).toBeDefined();
		expect(screen.queryByRole('menuitem', {name: 'Edit'})).toBeNull();
		expect(screen.queryByRole('menuitem', {name: 'Delete'})).toBeNull();
	});

	test('counts on each agent in the list its threads ended unread, the open one’s too, and marks one whose only news is from a thread at work, but the open one', async () => {
		const travel = persona('travel', 'Travel', true);
		const said = (id: string, ended: boolean) => ({
			threadId: id,
			answer: {id: `${id}-answer`, text: 'Done.'},
			ended,
		});
		const chat = (id: string, name: string, unread: ChatAnswer['unread']): ChatAnswer => ({
			personaId: id,
			name,
			answer: {id: `${id}-answer`, text: 'Done.'},
			unread,
		});
		answers = [
			chat('general', 'General', [said('g1', true), said('g2', true), said('g3', false)]),
			chat('finance', 'Finance', [said('f1', true)]),
			chat('travel', 'Travel', [said('t1', false)]),
		];
		renderChatPage({personas: [general, finance, travel]});

		const generalRow = await screen.findByRole('link', {name: /General/});
		await waitFor(() => {
			expect(within(generalRow).getByRole('status', {name: '2 unread'}).textContent).toBe('2');
		});
		const financeRow = screen.getByRole('link', {name: /Finance/});
		expect(within(financeRow).getByRole('status', {name: '1 unread'}).textContent).toBe('1');
		const travelRow = screen.getByRole('link', {name: /Travel/});
		expect(within(travelRow).getByRole('status', {name: 'Unread'})).toBeDefined();

		await follow(travelRow);
		await waitFor(() => {
			expect(
				within(screen.getByRole('link', {name: /Travel/})).queryByRole('status', {name: 'Unread'}),
			).toBeNull();
		});
		expect(
			within(screen.getByRole('link', {name: /General/})).getByRole('status', {name: '2 unread'}),
		).toBeDefined();
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
				unread: [{threadId: 't1', answer: {id: 'm2', text: 'Moved it to Thursday.'}, ended: true}],
			},
		];
		// The provider asks again once the open thread is read: by then Finance has answered.
		answering((input) => {
			if (input.endsWith('/read')) {
				const news = {id: 'finance-new', text: 'New news.'};
				answers = [
					{
						personaId: 'finance',
						name: 'Finance',
						answer: news,
						unread: [{threadId: 'finance-thread', answer: news, ended: true}],
					},
				];
				listed = [general, saidBy('New news.')];
			}
			return null;
		});
		renderChatPage({
			threads: [pricing],
			listPersonas: () => listed,
			initial: '/acme/chat/general/threads/t1',
		});

		const financeRow = await screen.findByRole('link', {name: /Finance/});
		expect(within(financeRow).getByText('Old news.')).toBeDefined();
		await waitFor(() => {
			expect(within(financeRow).getByRole('status', {name: '1 unread'})).toBeDefined();
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
		typeIn(await openNewTask(), 'Hi');
		fireEvent.click(screen.getByRole('button', {name: 'Send'}));
		await waitFor(() => expect(order()).toEqual(['General', 'Travel', 'Finance']));
		expect(screen.getByRole('link', {name: /General/}).textContent).toContain('You: Hi');
	});

	test('reads a thread up to its unread answer once it is open and shows it, and no other thread', async () => {
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm5', text: 'Both are paid.'},
				unread: [
					{threadId: 't1', answer: {id: 'm2', text: 'Moved it to Thursday.'}, ended: true},
					{threadId: 't3', answer: {id: 'm5', text: 'Both are paid.'}, ended: true},
				],
			},
		];
		renderChatPage({
			threads: [backup, pricing, thread('t3', {title: 'Invoices for October'})],
			initial: '/acme/chat/general/threads/t1',
		});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/general/read',
				expect.objectContaining({method: 'POST', body: JSON.stringify({entryId: 'm2'})}),
			);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(1);
	});

	test('marks each thread whose turn ended unread until the person opens it, which reads it; not one at work, and nothing as the list shows it', async () => {
		const invoices = thread('t3', {
			title: 'Invoices for October',
			latest: 'Both are paid.',
			latestEntryId: 'm5',
			createdAt: '2026-10-21T10:02:00Z',
		});
		const moved = {threadId: 't1', answer: {id: 'm2', text: 'Moved it to Thursday.'}, ended: true};
		const paid = {threadId: 't3', answer: {id: 'm5', text: 'Both are paid.'}, ended: true};
		const checking = {threadId: 't2', answer: {id: 'm8', text: 'Checking.'}, ended: false};
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm8', text: 'Checking.'},
				unread: [moved, paid, checking],
			},
		];
		// The thread read is no longer unread when the provider asks again.
		const reads = () =>
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read');
		answering((input) => {
			if (input.endsWith('/read')) {
				answers = [
					{
						personaId: 'general',
						name: 'General',
						answer: {id: 'm8', text: 'Checking.'},
						unread: [paid, checking],
					},
				];
			}
			return null;
		});
		const rowOf = (name: string) => screen.getByRole('link', {name}).parentElement ?? document.body;
		renderChatPage({threads: [pricing, backup, invoices]});

		await waitFor(() => {
			expect(
				within(rowOf('Invoices for October')).getByRole('status', {name: 'Unread'}),
			).toBeDefined();
		});
		expect(
			within(rowOf('Pricing review with Dana')).getByRole('status', {name: 'Unread'}),
		).toBeDefined();
		expect(within(rowOf('Morning check')).queryByRole('status', {name: 'Unread'})).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reads()).toHaveLength(0);

		await follow(screen.getByRole('link', {name: 'Pricing review with Dana'}));
		await waitFor(() => expect(reads()).toHaveLength(1));
		expect(reads()[0]?.[1]?.body).toBe(JSON.stringify({entryId: 'm2'}));
		await waitFor(() => {
			expect(
				within(rowOf('Pricing review with Dana')).queryByRole('status', {name: 'Unread'}),
			).toBeNull();
		});
		expect(
			within(rowOf('Invoices for October')).getByRole('status', {name: 'Unread'}),
		).toBeDefined();
	});

	test('renames the open thread from its name in the title bar, at once in the list and on the server; Escape puts the name back', async () => {
		// The server holds its answer, so the page shows the new name before it has it.
		let answer: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			answer = resolve;
		});
		answering((input) =>
			input.endsWith('/threads/t1/title')
				? held.then(() => new Response(null, {status: 204}))
				: null,
		);
		renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
		const name = (await screen.findByRole('textbox', {name: 'Thread name'})) as HTMLInputElement;
		expect(name.value).toBe('Pricing review with Dana');
		const renamedTo = () =>
			fetchMock.mock.calls.flatMap(([input, init]) =>
				input.endsWith('/chat/personas/general/threads/t1/title') && init?.method === 'PUT'
					? [(JSON.parse(String(init.body)) as {title: string}).title]
					: [],
			);

		act(() => name.focus());
		fireEvent.change(name, {target: {value: 'Something else'}});
		fireEvent.keyDown(name, {key: 'Escape'});
		expect(name.value).toBe('Pricing review with Dana');
		expect(renamedTo()).toEqual([]);
		// Escape went to the name, not to the thread, which is still open.
		expect(screen.getByRole('textbox', {name: 'Thread name'})).toBe(name);

		act(() => name.focus());
		fireEvent.change(name, {target: {value: '  Dana’s pricing  '}});
		fireEvent.keyDown(name, {key: 'Enter'});
		await waitFor(() => expect(renamedTo()).toEqual(['Dana’s pricing']));
		const chat = await screen.findByLabelText('Tasks');
		expect(within(chat).getByRole('link', {name: 'Dana’s pricing'})).toBeTruthy();
		expect(name.value).toBe('Dana’s pricing');
		await act(async () => answer());
	});

	test('an empty name renames nothing and the thread keeps its name', async () => {
		renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
		const name = (await screen.findByRole('textbox', {name: 'Thread name'})) as HTMLInputElement;
		act(() => name.focus());
		fireEvent.change(name, {target: {value: '   '}});
		act(() => name.blur());
		expect(name.value).toBe('Pricing review with Dana');
		expect(fetchMock.mock.calls.some(([input]) => input.endsWith('/threads/t1/title'))).toBe(false);
	});

	test('reads nothing of an open thread that does not show its unread answer yet', async () => {
		answers = [
			{
				personaId: 'general',
				name: 'General',
				answer: {id: 'm9', text: 'Something newer.'},
				unread: [{threadId: 't1', answer: {id: 'm9', text: 'Something newer.'}, ended: true}],
			},
		];
		renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});

		await screen.findByText('Thursday');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(
			fetchMock.mock.calls.filter(([url]) => url === '/api/orgs/acme/chat/personas/general/read'),
		).toHaveLength(0);
	});

	test('lists the threads, the one opened last on top, each a row of one line with where it stands, its title and how long ago its last message came', async () => {
		const asleep = thread('t3', {
			title: 'Train tickets',
			state: {kind: 'asleep', until: '2026-10-21T12:00:00Z'},
			standing: 'in_progress',
			opener: {kind: 'person', text: 'Book the train to Porto', attachments: []},
			latest: 'Waiting for the fares to drop.',
			latestEntryId: 'm7',
			messageCount: 1,
			lastMessageAt: '2026-10-21T10:09:00Z',
			createdAt: '2026-10-21T10:09:00Z',
		});
		renderChatPage({threads: [pricing, backup, asleep]});

		const chat = await screen.findByLabelText('Tasks');
		const links = within(chat).getAllByRole('link');
		expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
			'Train tickets',
			'Morning check',
			'Pricing review with Dana',
		]);
		expect(links.map((link) => link.getAttribute('href'))).toEqual([
			'/acme/chat/general/threads/t3',
			'/acme/chat/general/threads/t2',
			'/acme/chat/general/threads/t1',
		]);
		const [sleeping, working, stopped] = links.map((link) => link.parentElement as HTMLElement);
		// In progress while at work or asleep; done once stopped needing nothing.
		expect(within(stopped as HTMLElement).queryByText('In progress')).toBeNull();
		expect(within(stopped as HTMLElement).getByText('Done')).toBeTruthy();
		expect(within(working as HTMLElement).getByText('In progress')).toBeTruthy();
		expect(within(sleeping as HTMLElement).getByText('In progress')).toBeTruthy();
		// Named by its title; what opened it, what the person said or what an alert brought, is the
		// thread's to show.
		expect(within(stopped as HTMLElement).getByText('Pricing review with Dana')).toBeTruthy();
		expect(within(stopped as HTMLElement).queryByText('Move the pricing review')).toBeNull();
		expect(within(working as HTMLElement).getByText('Morning check')).toBeTruthy();
		expect(
			within(working as HTMLElement).queryByText('Every weekday at 9:00, as you asked'),
		).toBeNull();
		// One line: the latest answer is the thread's to show too.
		expect(within(stopped as HTMLElement).queryByText('Moved it to Thursday.')).toBeNull();
		expect(
			within(sleeping as HTMLElement).queryByText('Waiting for the fares to drop.'),
		).toBeNull();
		expect(within(sleeping as HTMLElement).getByText(formatAgo(asleep.lastMessageAt))).toBeTruthy();
	});

	test('reads the chat again while a thread of it is in progress, so one that stops says so', async () => {
		let listed = [backup];
		renderChatPage({listThreads: () => listed});

		const chat = await screen.findByLabelText('Tasks');
		expect(within(chat).getByText('In progress')).toBeTruthy();
		listed = [{...backup, state: {kind: 'stopped'}, standing: 'done', latest: 'The backup ran.'}];
		// The chat is read again within the 4 seconds it waits between reads.
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(within(chat).queryByText('In progress')).toBeNull();
		expect(within(chat).getByText('Done')).toBeTruthy();
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

		const chat = await screen.findByLabelText('Tasks');
		expect(within(chat).getByText('Done')).toBeTruthy();
		listed = [{...pricing, standing: 'waiting', summary: 'Asks which day suits Dana.'}];
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(within(chat).getByText('Waiting for you')).toBeTruthy();

		// Written, there is nothing more to read it again for.
		const read = reads;
		await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
		expect(reads).toBe(read);
	}, 15000);

	test('offers to mark done only a thread waiting for the person', async () => {
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
		renderChatPage({threads: [pricing, backup, waiting]});

		const chat = await screen.findByLabelText('Tasks');
		const [asking, working, done] = within(chat)
			.getAllByRole('link')
			.map((link) => link.parentElement as HTMLElement);
		expect(within(asking as HTMLElement).getByText('Waiting for you')).toBeTruthy();
		expect(within(asking as HTMLElement).getByRole('button', {name: 'Mark done'})).toBeTruthy();
		expect(within(done as HTMLElement).getByText('Done')).toBeTruthy();
		expect(within(done as HTMLElement).queryByRole('button', {name: 'Mark done'})).toBeNull();
		expect(within(working as HTMLElement).getByText('In progress')).toBeTruthy();
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

		const chat = await screen.findByLabelText('Tasks');
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

		const chat = await screen.findByLabelText('Tasks');
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

		const chat = await screen.findByLabelText('Tasks');
		// One archive button, on the thread that is done; the one waiting has the check.
		expect(within(chat).getAllByRole('button', {name: 'Archive'})).toHaveLength(1);
		expect(within(chat).getAllByRole('button', {name: 'Mark done'})).toHaveLength(1);

		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		expect(within(chat).queryByRole('link', {name: 'Quarterly numbers'})).toBeNull();
		expect(within(chat).queryByText('Sent the numbers.', {ignore: GOING})).toBeNull();
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

		const chat = await screen.findByLabelText('Tasks');
		await follow(within(chat).getByRole('button', {name: 'Mark done'}));
		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		expect(within(chat).queryByText('Done', {ignore: GOING})).toBeNull();
	});

	test('where the server can’t archive a thread, it is back in the list, saying why', async () => {
		const done = thread('t5', {title: 'Quarterly numbers', standing: 'done'});
		answering((input) =>
			input.endsWith('/threads/t5/archive')
				? Promise.resolve(Response.json({error: 'Something went wrong'}, {status: 500}))
				: null,
		);
		renderChatPage({threads: [done]});

		const chat = await screen.findByLabelText('Tasks');
		await follow(within(chat).getByRole('button', {name: 'Archive'}));

		await waitFor(() =>
			expect(within(chat).getByRole('link', {name: 'Quarterly numbers'})).toBeTruthy(),
		);
		expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
	});

	describe('alerts that come to a thread', () => {
		// Whether the page asked the api to say the thread is done, cancelling its alerts or not.
		function postedDone(threadId: string, cancelAlerts: boolean): boolean {
			return fetchMock.mock.calls.some(
				([input, init]) =>
					input.endsWith(`/threads/${threadId}/done`) &&
					init?.method === 'POST' &&
					typeof init.body === 'string' &&
					(JSON.parse(init.body) as {cancelAlerts?: boolean}).cancelAlerts === cancelAlerts,
			);
		}

		function postedTo(path: string): boolean {
			return fetchMock.mock.calls.some(([input]) => input.endsWith(path));
		}

		test('show at the end of the open thread as a line to the Alerts page showing them', async () => {
			const watched = thread('t4', {alerts: 2});
			renderChatPage({
				threads: [watched],
				views: {t4: view(watched, [said('m1', 'person', 'Watch for the contract')])},
				initial: '/acme/chat/general/threads/t4',
			});

			const opened = await screen.findByLabelText('Thread');
			const line = within(opened).getByRole('link', {name: /Watching 2 things in the background/});
			expect(line.getAttribute('href')).toBe('/acme/alerts?thread=t4');
		});

		test('say one alert in the singular, and nothing where none comes to the thread', async () => {
			const one = thread('t4', {title: 'Call the landlord', alerts: 1});
			renderChatPage({
				threads: [one, pricing],
				views: {t4: view(one, [said('m1', 'person', 'Remind me')]), t1: pricingView},
				initial: '/acme/chat/general/threads/t4',
			});

			expect(
				within(await screen.findByLabelText('Thread')).getByText(
					'Watching 1 thing in the background',
				),
			).toBeTruthy();
			await follow(screen.getByRole('link', {name: 'Pricing review with Dana'}));
			await waitFor(() =>
				expect(within(screen.getByLabelText('Thread')).getByText('Thursday')).toBeTruthy(),
			);
			expect(screen.queryByText(/in the background/)).toBeNull();
		});

		test('ask first as a thread with them is marked done, and Back leaves it waiting', async () => {
			renderChatPage({threads: [thread('t4', {standing: 'waiting', alerts: 2})]});

			const chat = await screen.findByLabelText('Tasks');
			await follow(within(chat).getByRole('button', {name: 'Mark done'}));

			const dialog = await screen.findByRole('dialog');
			expect(dialog.textContent).toContain('This thread is still watching 2 things');
			expect(dialog.textContent).toContain('Its agent comes back to it when something turns up.');
			await follow(within(dialog).getByRole('button', {name: 'Back'}));

			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(within(chat).getByText('Waiting for you')).toBeTruthy();
			expect(postedTo('/threads/t4/done')).toBe(false);
		});

		test('marked done keeping them, it is watching and they stay', async () => {
			renderChatPage({threads: [thread('t4', {standing: 'waiting', alerts: 2})]});

			const chat = await screen.findByLabelText('Tasks');
			await follow(within(chat).getByRole('button', {name: 'Mark done'}));
			await follow(
				within(await screen.findByRole('dialog')).getByRole('button', {
					name: 'Mark done, keep watching',
				}),
			);

			await waitFor(() => expect(within(chat).getByText('Watching')).toBeTruthy());
			expect(within(chat).queryByText('Done')).toBeNull();
			await waitFor(() => expect(postedDone('t4', false)).toBe(true));
			expect(postedDone('t4', true)).toBe(false);
		});

		test('marked done cancelling them, it is done and the server cancels them', async () => {
			renderChatPage({threads: [thread('t4', {standing: 'waiting', alerts: 1})]});

			const chat = await screen.findByLabelText('Tasks');
			await follow(within(chat).getByRole('button', {name: 'Mark done'}));
			const dialog = await screen.findByRole('dialog');
			expect(dialog.textContent).toContain('This thread is still watching 1 thing');
			await follow(within(dialog).getByRole('button', {name: 'Stop watching and mark done'}));

			await waitFor(() => expect(within(chat).getByText('Done')).toBeTruthy());
			await waitFor(() => expect(postedDone('t4', true)).toBe(true));
		});

		test('say a thread done with them is watching, and archive it from its row and its title bar', async () => {
			const watching = thread('t4', {title: 'Contract from Dana', standing: 'watching', alerts: 1});
			renderChatPage({
				threads: [watching],
				views: {t4: view(watching, [said('m1', 'person', 'Watch for the contract')])},
				initial: '/acme/chat/general/threads/t4',
			});

			const chat = await screen.findByLabelText('Tasks');
			expect(within(chat).getByText('Watching')).toBeTruthy();
			expect(within(chat).getByRole('button', {name: 'Archive'})).toBeTruthy();
			expect(within(chat).queryByRole('button', {name: 'Mark done'})).toBeNull();
			const banner = await screen.findByRole('banner');
			await waitFor(() => expect(within(banner).getByText('Watching')).toBeTruthy());
			expect(within(banner).getByRole('button', {name: 'Archive'})).toBeTruthy();
		});

		test('ask first as a thread with them is archived, offering only to cancel them or go back', async () => {
			const done = thread('t5', {title: 'Quarterly numbers', standing: 'done', alerts: 2});
			renderChatPage({threads: [done]});

			const chat = await screen.findByLabelText('Tasks');
			await follow(within(chat).getByRole('button', {name: 'Archive'}));

			const dialog = await screen.findByRole('dialog');
			expect(within(dialog).queryByRole('button', {name: /keep watching/})).toBeNull();
			await follow(within(dialog).getByRole('button', {name: 'Back'}));
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(within(chat).getByRole('link', {name: 'Quarterly numbers'})).toBeTruthy();
			expect(postedTo('/threads/t5/archive')).toBe(false);

			await follow(within(chat).getByRole('button', {name: 'Archive'}));
			await follow(
				within(await screen.findByRole('dialog')).getByRole('button', {
					name: 'Stop watching and archive',
				}),
			);

			await waitFor(() =>
				expect(within(chat).queryByRole('link', {name: 'Quarterly numbers'})).toBeNull(),
			);
			await waitFor(() => expect(postedTo('/threads/t5/archive')).toBe(true));
		});

		test('the chat’s own alerts, which open threads of their own, are a line at its end to the Alerts page showing them', async () => {
			renderChatPage({threads: [pricing], chatAlerts: 2});

			const chat = await screen.findByLabelText('Tasks');
			const line = await within(chat).findByRole('link', {
				name: 'Watching 2 things in the background',
			});
			expect(line.getAttribute('href')).toBe('/acme/alerts?chat=general');
		});

		test('a chat without alerts of its own has no line for them', async () => {
			renderChatPage({threads: [pricing]});

			const chat = await screen.findByLabelText('Tasks');
			await within(chat).findByRole('link', {name: pricing.title});
			expect(within(chat).queryByText(/in the background/)).toBeNull();
		});
	});

	describe('a thread', () => {
		test('switches what runs it from under its own input, even of an agent the person may not change, leaving the agent as it is', async () => {
			fetchMock.mockImplementation((input) =>
				Promise.resolve(
					input.endsWith('/chat/answers')
						? Response.json({answers: []})
						: new Response(null, {status: 204}),
				),
			);
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});

			const thread = await screen.findByLabelText('Thread');
			// General's own is only said, under the chat's input; the thread's can be switched.
			fireEvent.click(
				await screen.findByRole('button', {name: 'Model: Claude Sonnet 5.5 on OpenRouter'}),
			);
			fireEvent.click(await screen.findByRole('menuitemradio', {name: 'GLM 5.3'}));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith(
					'/api/orgs/acme/chat/personas/general/threads/t1/model',
					expect.objectContaining({
						method: 'PUT',
						body: JSON.stringify({harness: 'proxy', chatModel: 'glm'}),
					}),
				);
			});
			expect(thread).toBeDefined();
			expect(screen.getByRole('button', {name: 'Model: GLM 5.3 on OpenRouter'})).toBeDefined();
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						input === '/api/orgs/acme/chat/personas/general' && init?.method === 'PUT',
				),
			).toBe(false);
		});

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
				within(screen.getByLabelText('Tasks')).queryByRole('link', {name: 'Quarterly numbers'}),
			).toBeNull();
			await waitFor(() =>
				expect(
					fetchMock.mock.calls.some(
						([input, init]) => input.endsWith('/threads/t5/archive') && init?.method === 'POST',
					),
				).toBe(true),
			);
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
			// Lit, where it is in the list.
			expect(link.parentElement?.classList.contains('bg-sidebar-accent')).toBe(true);
			expect(
				screen
					.getByRole('link', {name: 'Morning check'})
					.parentElement?.classList.contains('bg-sidebar-accent'),
			).toBe(false);
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
			const chat = screen.getByLabelText('Tasks');
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
			const chat = await screen.findByLabelText('Tasks');

			await follow(screen.getByRole('link', {name: 'Pricing review with Dana'}));
			await screen.findByRole('status', {name: 'Loading'});
			expect(within(screen.getByRole('banner')).getByText('Pricing review with Dana')).toBeTruthy();
			expect(screen.getByLabelText('Tasks')).toBe(chat);

			await act(async () => arrive());
			await screen.findByLabelText('Thread');
			expect(screen.getByLabelText('Tasks')).toBe(chat);
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
			// Nothing of it is kept as a draft, the chat's or the thread's.
			expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/draft'))).toEqual([]);
		});

		test('answers a reply of /trace with the thread id, sending nothing', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			const opened = await screen.findByLabelText('Thread');
			const box = screen.getByLabelText('Reply');

			typeIn(box, '/trace');
			fireEvent.click(
				within(box.closest('form') as HTMLElement).getByRole('button', {name: 'Send'}),
			);

			expect(await within(opened).findByText('t1')).toBeTruthy();
			expect(within(opened).getByRole('button', {name: 'Copy thread id'})).toBeTruthy();
			expect(within(opened).queryByText('/trace')).toBeNull();
			expect(box.textContent).toBe('');
			expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/threads/t1/messages'))).toBe(
				false,
			);
		});

		test('sends /trace among other words as any reply', async () => {
			answering((input, init) =>
				input.endsWith('/threads/t1/messages') && init?.method === 'POST'
					? Promise.resolve(Response.json({message: said('m4', 'person', 'what does /trace do')}))
					: null,
			);
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');
			const box = screen.getByLabelText('Reply');

			typeIn(box, 'what does /trace do');
			fireEvent.click(
				within(box.closest('form') as HTMLElement).getByRole('button', {name: 'Send'}),
			);

			await waitFor(() =>
				expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/threads/t1/messages'))).toBe(
					true,
				),
			);
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
				initial: '/acme/chat/general/threads/t1',
			});
			const box = await screen.findByLabelText('Reply');
			const file = new File(['hello'], 'notes.txt', {type: 'text/plain'});
			fireEvent.drop(window, {dataTransfer: {types: ['Files'], files: [file]}});

			await waitFor(() => expect(box.textContent).toBe('notes.txt '));
			// No new task's box beside it to take them.
			expect(screen.queryByLabelText('Message')).toBeNull();
			const uploads = fetchMock.mock.calls
				.filter(([url]) => url.includes('/attachments'))
				.map(([url]) => url.split('?')[0]);
			expect(uploads).toEqual(['/api/orgs/acme/chat/personas/general/threads/t1/attachments']);
		});

		test('stays open, with no way to close it or give it the page’s width, Escape included', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');
			expect(screen.queryByRole('button', {name: 'Close'})).toBeNull();
			expect(screen.queryByRole('button', {name: 'Expand'})).toBeNull();

			await act(async () => {
				fireEvent.keyDown(document.body, {key: 'Escape'});
			});
			expect(screen.getByLabelText('Thread')).toBeTruthy();
			expect(
				screen.getByRole('link', {name: 'Pricing review with Dana'}).getAttribute('aria-current'),
			).toBe('page');
		});

		test('stays open under a new task’s box, focused, from the New task button', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');

			await openNewTask();
			expect(screen.getByRole('dialog', {name: 'New task for General'})).toBeTruthy();
			expect(screen.getByLabelText('Thread')).toBeTruthy();
		});

		test('stays open under a new task’s box, focused, at the platform’s shortcut with N', async () => {
			renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
			await screen.findByLabelText('Thread');

			await act(async () => {
				fireEvent.keyDown(document.body, {key: 'n', code: 'KeyN', ctrlKey: true, metaKey: true});
			});
			expect(screen.queryByLabelText('Message')).toBeNull();

			const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
			await act(async () => {
				fireEvent.keyDown(document.body, {
					key: 'n',
					code: 'KeyN',
					metaKey: apple,
					ctrlKey: !apple,
				});
			});
			const box = await screen.findByLabelText('Message');
			await waitFor(() => expect(document.activeElement).toBe(box));
			expect(screen.getByLabelText('Thread')).toBeTruthy();
		});

		test('says where it is gone, the title bar waiting for no name', async () => {
			const {container} = renderChatPage({threads: [], initial: '/acme/chat/general/threads/t9'});

			expect(await screen.findByText('This thread does not exist anymore.')).toBeTruthy();
			const bar = screen.getByRole('banner');
			await waitFor(() => expect(within(bar).getByText('Thread')).toBeTruthy());
			expect(bar.querySelector('[data-slot="skeleton"]')).toBeNull();
			expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
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
			fireEvent.click(within(viewer).getByRole('button', {name: 'Previous file'}));
			expect(whole().getAttribute('alt')).toBe('Stores');

			fireEvent.click(within(viewer).getByRole('button', {name: 'Close'}));
			await waitFor(() => expect(viewer.isConnected).toBe(false));
		});
	});

	describe('the agent’s settings', () => {
		const settings = () => screen.getByRole('region', {name: 'Agent settings'});

		test('open at the page’s right from the agent’s name over its tasks, pressed while open, at an address of their own, and close from it again', async () => {
			const {router} = renderChatPage({open: 'finance'});
			const title = await screen.findByRole('button', {name: 'Finance settings'});
			expect(title.getAttribute('aria-pressed')).toBe('false');

			await follow(title);
			await screen.findByRole('region', {name: 'Agent settings'});
			expect(router.state.location.pathname).toBe('/acme/chat/finance/settings');
			expect(
				screen.getByRole('button', {name: 'Finance settings'}).getAttribute('aria-pressed'),
			).toBe('true');
			expect(screen.getByLabelText('Tasks')).toBeTruthy();
			expect(screen.getByText('What should Finance do?')).toBeTruthy();

			await follow(screen.getByRole('button', {name: 'Finance settings'}));
			await waitFor(() =>
				expect(screen.queryByRole('region', {name: 'Agent settings'})).toBeNull(),
			);
			expect(router.state.location.pathname).toBe('/acme/chat/finance');
		});

		test('open beside the open task, which stays open, as another task opens too, and close by their cross back to the task', async () => {
			const later = thread('t3', {title: 'Invoice for Northwind'});
			const {router} = renderChatPage({
				threads: [pricing, later],
				views: {t1: pricingView, t3: view(later, [said('m5', 'person', 'Send the invoice')])},
				initial: '/acme/chat/general/threads/t1',
			});
			await screen.findByLabelText('Thread');

			await follow(screen.getByRole('button', {name: 'General settings'}));
			await screen.findByRole('region', {name: 'Agent settings'});
			expect(router.state.location.pathname).toBe('/acme/chat/general/threads/t1/settings');
			expect(screen.getByLabelText('Thread')).toBeTruthy();
			expect(
				screen.getByRole('link', {name: 'Pricing review with Dana'}).getAttribute('aria-current'),
			).toBe('page');

			await follow(screen.getByRole('link', {name: 'Invoice for Northwind'}));
			await screen.findByText('Send the invoice');
			expect(router.state.location.pathname).toBe('/acme/chat/general/threads/t3/settings');
			expect(settings()).toBeTruthy();

			await follow(screen.getByRole('button', {name: 'Close settings'}));
			await waitFor(() =>
				expect(screen.queryByRole('region', {name: 'Agent settings'})).toBeNull(),
			);
			expect(router.state.location.pathname).toBe('/acme/chat/general/threads/t3');
			expect(screen.getByLabelText('Thread')).toBeTruthy();
		});

		test('open from Settings in the right-click menu, for an agent the person may not change too, read alone, and close with Back', async () => {
			const everyone = {...general, shared: true};
			const {router} = renderChatPage({personas: [everyone, finance]});
			await screen.findByText('What should General do?');

			fireEvent.contextMenu(screen.getByRole('link', {name: /General/}));
			await follow(await screen.findByRole('menuitem', {name: 'Settings'}));
			const pane = await screen.findByRole('region', {name: 'Agent settings'});
			expect(router.state.location.pathname).toBe('/acme/chat/general/settings');
			expect(within(pane).getByText('Made by Dana')).toBeTruthy();
			expect(
				within(pane).getByText(
					'Everyone in Acme. Each person’s conversation with it is their own.',
				),
			).toBeTruthy();
			expect(within(pane).queryByRole('button', {name: 'Edit'})).toBeNull();
			expect(within(pane).queryByRole('button', {name: 'Only you'})).toBeNull();
			expect(within(pane).queryByRole('button', {name: 'Delete agent'})).toBeNull();

			await act(async () => {
				await router.navigate(-1);
			});
			await waitFor(() =>
				expect(screen.queryByRole('region', {name: 'Agent settings'})).toBeNull(),
			);
		});

		test('show an agent the person may change: its name, whose it is, Edit, who sees it, and the card that deletes it', async () => {
			renderChatPage({open: 'finance', initial: '/acme/chat/finance/settings'});
			const pane = await screen.findByRole('region', {name: 'Agent settings'});

			expect(within(pane).getByText('Finance')).toBeTruthy();
			expect(within(pane).getByText('Yours alone')).toBeTruthy();
			expect(within(pane).getByRole('button', {name: 'Edit'})).toBeTruthy();
			expect(within(pane).getByRole('region', {name: 'Who sees it'})).toBeTruthy();
			expect(
				within(pane).getByRole('button', {name: 'Only you'}).getAttribute('aria-pressed'),
			).toBe('true');
			expect(within(pane).getByText('Nobody else in Acme sees it.')).toBeTruthy();
			expect(within(pane).getByRole('heading', {name: 'Delete Finance'})).toBeTruthy();
			expect(
				within(pane).getByText(
					'Your conversation with Finance goes with it. This cannot be undone.',
				),
			).toBeTruthy();
			// Nothing of Slack without the experiment.
			expect(within(pane).queryByText(/Slack/)).toBeNull();
		});

		test('say on an agent that is the person’s alone that it has to be shared to be added to Slack, asking nothing of the api', async () => {
			renderChatPage({open: 'finance', slack: true, initial: '/acme/chat/finance/settings'});
			const row = within(await screen.findByRole('region', {name: 'Agent settings'})).getByRole(
				'region',
				{name: 'Slack'},
			);

			expect(
				within(row).getByText('Share it with everyone in Acme to add it to Slack'),
			).toBeTruthy();
			expect(within(row).queryByRole('button')).toBeNull();
			expect(fetchMock).not.toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/finance/slack',
				expect.anything(),
			);
		});

		test('have a Slack card for a shared agent with the experiment, whose action opens the Slack dialog, and say on the card that deletes it that it leaves Slack', async () => {
			answering((input) =>
				input.endsWith('/chat/personas/finance/slack')
					? Promise.resolve(Response.json(financeInSlack))
					: null,
			);
			renderChatPage({
				personas: [general, {...finance, shared: true}],
				open: 'finance',
				slack: true,
				initial: '/acme/chat/finance/settings',
			});
			const row = within(await screen.findByRole('region', {name: 'Agent settings'})).getByRole(
				'region',
				{name: 'Slack'},
			);

			expect(await within(row).findByText('@finance in Northwind')).toBeTruthy();
			expect(within(settings()).getByText(/It is removed from Slack first\./)).toBeTruthy();
			fireEvent.click(within(row).getByRole('button', {name: 'Manage'}));
			const dialog = await screen.findByRole('dialog');
			expect(within(dialog).getByText(/Finance is in Northwind as @finance/)).toBeTruthy();
		});

		test('tell a member who may not change a shared agent where to write to it in Slack', async () => {
			const research = {
				...persona('research', 'Research', false),
				shared: true,
				madeBy: {name: 'Dana'},
			};
			answering((input) =>
				input.endsWith('/chat/personas/research/slack/presence')
					? Promise.resolve(
							Response.json({
								inSlack: {
									handle: 'research',
									workspaceName: 'Northwind',
									slackUrl: 'https://slack.com/app_redirect?app=A02&team=T01',
								},
							}),
						)
					: null,
			);
			renderChatPage({
				personas: [general, research],
				open: 'research',
				slack: true,
				initial: '/acme/chat/research/settings',
			});
			const pane = await screen.findByRole('region', {name: 'Agent settings'});

			expect(await within(pane).findByText('@research in Northwind')).toBeTruthy();
			expect(within(pane).getByRole('link', {name: 'Open in Slack'}).getAttribute('href')).toBe(
				'https://slack.com/app_redirect?app=A02&team=T01',
			);
			expect(fetchMock).not.toHaveBeenCalledWith(
				'/api/orgs/acme/chat/personas/research/slack',
				expect.anything(),
			);
		});

		test('open on the Slack dialog saying how the install ended, coming back from Slack, at an address that forgets it', async () => {
			answering((input) =>
				input.endsWith('/chat/personas/finance/slack')
					? Promise.resolve(Response.json(financeInSlack))
					: null,
			);
			const {router} = renderChatPage({
				personas: [general, {...finance, shared: true}],
				open: 'finance',
				slack: true,
				initial: '/acme/chat/finance?slack=installed',
			});

			const dialog = await screen.findByRole('dialog');
			expect(await within(dialog).findByText('Finance is in Slack.')).toBeDefined();
			await waitFor(() =>
				expect(router.state.location.pathname).toBe('/acme/chat/finance/settings'),
			);
			expect(router.state.location.search).toBe('');
			expect(screen.getByRole('region', {name: 'Agent settings', hidden: true})).toBeTruthy();
		});

		test('say whose a shared agent is: made by the person, by another member, or, where its maker has left, whom it is for', async () => {
			const travel = {...persona('travel', 'Travel', true), shared: true};
			const research = {
				...persona('research', 'Research', false),
				shared: true,
				madeBy: {name: 'Dana'},
			};
			// Whose maker has left the organization.
			const scout = {...persona('scout', 'Scout', false), shared: true, madeBy: null};
			const lines: Array<[ListedPersona, string]> = [
				[travel, 'Made by you, for everyone in Acme'],
				[research, 'Made by Dana'],
				[scout, 'For everyone in Acme'],
			];
			for (const [shown, line] of lines) {
				renderChatPage({
					personas: [scout, travel, research],
					open: shown.id,
					initial: `/acme/chat/${shown.id}/settings`,
				});
				const pane = await screen.findByRole('region', {name: 'Agent settings'});
				expect(within(pane).getByText(line)).toBeTruthy();
				cleanup();
			}
		});

		test('share the agent as soon as everyone is chosen, without a Save', async () => {
			answering((_input, init) =>
				init?.method === 'PUT'
					? Promise.resolve(Response.json({persona: {...finance, shared: true}}))
					: null,
			);
			renderChatPage({open: 'finance', initial: '/acme/chat/finance/settings', others: true});
			const pane = await screen.findByRole('region', {name: 'Agent settings'});

			fireEvent.click(within(pane).getByRole('button', {name: 'Everyone in Acme'}));

			expect(
				within(pane).getByRole('button', {name: 'Everyone in Acme'}).getAttribute('aria-pressed'),
			).toBe('true');
			expect(
				within(pane).getByText('Each person’s conversation with it is their own.'),
			).toBeTruthy();
			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith(
					'/api/orgs/acme/chat/personas/finance',
					expect.objectContaining({
						method: 'PUT',
						body: JSON.stringify({name: 'Finance', look, color: 'blue', shared: true}),
					}),
				);
			});
			expect(within(pane).queryByRole('button', {name: 'Save'})).toBeNull();
		});

		test('say in place why the agent can’t be the person’s alone, up front and where the api refuses it', async () => {
			const refusal = 'Others in Acme are using Finance, so it stays shared.';
			const kept = {...finance, shared: true, usedByOthers: true, staysShared: refusal};
			renderChatPage({
				personas: [general, kept],
				open: 'finance',
				initial: '/acme/chat/finance/settings',
			});
			let pane = await screen.findByRole('region', {name: 'Agent settings'});
			expect(within(pane).getByRole('button', {name: 'Only you'}).hasAttribute('disabled')).toBe(
				true,
			);
			expect(within(pane).getByText(refusal)).toBeTruthy();
			expect(
				within(pane).getByText(
					'Every member’s conversation with Finance goes with it, not only yours: others have talked to it. This cannot be undone.',
				),
			).toBeTruthy();
			cleanup();

			// Someone said something to it since the list was read.
			answering((_input, init) =>
				init?.method === 'PUT'
					? Promise.resolve(Response.json({error: 'conflict', message: refusal}, {status: 409}))
					: null,
			);
			renderChatPage({
				personas: [general, {...finance, shared: true}],
				open: 'finance',
				initial: '/acme/chat/finance/settings',
			});
			pane = await screen.findByRole('region', {name: 'Agent settings'});
			fireEvent.click(within(pane).getByRole('button', {name: 'Only you'}));

			expect(await within(pane).findByText(refusal)).toBeTruthy();
			expect(
				within(pane).getByRole('button', {name: 'Everyone in Acme'}).getAttribute('aria-pressed'),
			).toBe('true');
		});

		test('open the name and the head in their dialog from Edit, saved by Save', async () => {
			answering((_input, init) =>
				init?.method === 'PUT'
					? Promise.resolve(Response.json({persona: {...finance, name: 'Accounting'}}))
					: null,
			);
			renderChatPage({open: 'finance', initial: '/acme/chat/finance/settings'});
			fireEvent.click(
				within(await screen.findByRole('region', {name: 'Agent settings'})).getByRole('button', {
					name: 'Edit',
				}),
			);

			expect(screen.getByRole('heading', {name: 'Edit agent'})).toBeDefined();
			expect(within(screen.getByRole('dialog')).queryByText('Who sees it')).toBeNull();
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

		test('delete the agent from its card after the confirmation, and close with it', async () => {
			const {router} = renderChatPage({open: 'finance', initial: '/acme/chat/finance/settings'});
			const pane = await screen.findByRole('region', {name: 'Agent settings'});

			fireEvent.click(within(pane).getByRole('button', {name: 'Delete agent'}));
			expect(screen.getByRole('heading', {name: 'Delete Finance?'})).toBeDefined();
			expect(screen.getByText(/and your conversation with it/)).toBeDefined();
			fireEvent.click(screen.getByRole('button', {name: 'Delete'}));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith(
					'/api/orgs/acme/chat/personas/finance',
					expect.objectContaining({method: 'DELETE'}),
				);
			});
			await waitFor(() => expect(router.state.location.pathname).not.toContain('/settings'));
		});
	});

	describe('sending', () => {
		// The api as it answers the opening of a thread: as `post` says, the rest as before.
		function answerSends(post: () => Promise<Response>) {
			answering((input, init) =>
				input.endsWith('/threads') && init?.method === 'POST' ? post() : null,
			);
		}

		test('opens a thread with what is sent, shown at once on top of the list, and opens it as the server answers, putting the box away', async () => {
			const answeredOpen: ((response: Response) => void)[] = [];
			answerSends(() => new Promise((resolve) => answeredOpen.push(resolve)));
			const started = opened('Book the train');
			renderChatPage({
				threads: [pricing],
				views: {
					t1: pricingView,
					't-new': view(started, [said('m1', 'person', 'Book the train')], true),
				},
			});
			const chat = await screen.findByLabelText('Tasks');
			const box = await openNewTask();

			typeIn(box, 'Book the train ');
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			const sent = await within(chat).findByText('Book the train');
			const row = sent.closest('li') as HTMLElement;
			expect(box.textContent).toBe('');
			// Behind the box, out of reach while it is open.
			expect(within(chat).getAllByRole('listitem', {hidden: true})[0]).toBe(row);
			// The server has yet to open it: there is nowhere for it to lead.
			expect(within(row).queryByRole('link', {hidden: true})).toBeNull();
			expect(within(row).getByText('In progress')).toBeTruthy();
			// The list has it as the last thing said at once.
			expect(screen.getByRole('link', {name: /General/, hidden: true}).textContent).toContain(
				'You: Book the train',
			);

			await waitFor(() => expect(answeredOpen).toHaveLength(1));
			const posted = fetchMock.mock.calls.find(
				([url, init]) => url.endsWith('/threads') && init?.method === 'POST',
			);
			expect(posted?.[0]).toBe('/api/orgs/acme/chat/personas/general/threads');
			await act(async () => {
				answeredOpen[0]?.(Response.json({thread: started}));
			});
			// Opened, it leads to the thread the server made, before the chat read again has it, and is
			// open, the box put away.
			const link = await within(chat).findByRole('link', {name: 'Book the train'});
			expect(link.getAttribute('href')).toBe('/acme/chat/general/threads/t-new');
			await screen.findByLabelText('Thread');
			expect(link.getAttribute('aria-current')).toBe('page');
			expect(screen.queryByLabelText('Message')).toBeNull();
		});

		test('puts what was sent back in the box, and takes it out of the chat, where the send fails', async () => {
			answerSends(() =>
				Promise.resolve(Response.json({error: 'The agent is gone'}, {status: 500})),
			);
			renderChatPage({threads: [pricing]});
			const chat = await screen.findByLabelText('Tasks');
			typeIn(await openNewTask(), 'Book the train');
			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			// The box is made again, holding what was sent.
			await waitFor(() =>
				expect(screen.getByLabelText('Message').textContent).toBe('Book the train'),
			);
			expect(within(chat).queryByText('Book the train', {ignore: GOING})).toBeNull();
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

			const box = await openNewTask();
			expect(box.textContent).toBe('Move the pricing review');
			expect(pageSaysSafeToReload()).toBe(true);
			expect(saves()).toEqual([]);
		});

		test('saves what is typed a moment after the typing stops, once', async () => {
			renderChatPage();
			const box = await openNewTask();

			typeIn(box, 'Move the');
			typeIn(box, 'Move the pricing review');
			expect(pageSaysSafeToReload()).toBe(false);

			await waitFor(() => expect(saves()).toEqual([{text: 'Move the pricing review'}]), {
				timeout: 2000,
			});
			await waitFor(() => expect(pageSaysSafeToReload()).toBe(true));
		});

		describe('in a thread', () => {
			const threadDraftUrl = '/api/orgs/acme/chat/personas/general/threads/t1/draft';
			const threadSaves = () =>
				fetchMock.mock.calls
					.filter(([url, init]) => url === threadDraftUrl && init?.method === 'PUT')
					.map(([, init]) => JSON.parse(String(init?.body)) as {text: string});

			test('opens its box with what was typed in it and not sent, safe to reload', async () => {
				renderChatPage({
					threads: [pricing],
					views: {t1: view(pricing, pricingView.messages, false, 'Thursday works')},
					initial: '/acme/chat/general/threads/t1',
				});

				const box = await screen.findByLabelText('Reply');
				expect(box.textContent).toBe('Thursday works');
				expect(pageSaysSafeToReload()).toBe(true);
				expect(threadSaves()).toEqual([]);
			});

			test('saves what is typed in it to the thread a moment after the typing stops, not to the chat', async () => {
				renderChatPage({threads: [pricing], initial: '/acme/chat/general/threads/t1'});
				const box = await screen.findByLabelText('Reply');

				typeIn(box, 'Thursday');
				typeIn(box, 'Thursday works');
				expect(pageSaysSafeToReload()).toBe(false);

				await waitFor(() => expect(threadSaves()).toEqual([{text: 'Thursday works'}]), {
					timeout: 2000,
				});
				await waitFor(() => expect(pageSaysSafeToReload()).toBe(true));
				expect(saves()).toEqual([]);
			});
		});

		test('saves at once as the box is put away, and lists it as a draft once another conversation opens', async () => {
			renderChatPage();
			const box = await openNewTask();
			typeIn(box, 'Move the pricing review');

			await act(async () => {
				fireEvent.keyDown(box, {key: 'Escape'});
			});
			await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
			expect(saves()).toEqual([{text: 'Move the pricing review'}]);

			await follow(screen.getByRole('link', {name: /Finance/}));
			await screen.findByText('What should Finance do?');

			expect(saves()).toEqual([{text: 'Move the pricing review'}]);
			const generalRow = screen.getByRole('link', {name: /General/});
			expect(generalRow.textContent).toContain('Draft: Move the pricing review');
		});

		test('lists another conversation’s draft as the server keeps it, not the open one’s', async () => {
			renderChatPage({
				personas: [
					{
						...general,
						lastMessage: {kind: 'assistant', text: 'How can I help?', at: '2026-10-21T10:00:00Z'},
					},
					{...finance, draft: 'Pay the invoice'},
				],
			});
			const box = await openNewTask();

			// Behind the box, out of reach while it is open.
			expect(screen.getByRole('link', {name: /Finance/, hidden: true}).textContent).toContain(
				'Draft: Pay the invoice',
			);
			const generalRow = screen.getByRole('link', {name: /General/, hidden: true});
			expect(generalRow.textContent).not.toContain('Draft:');
			expect(generalRow.textContent).toContain('How can I help?');

			typeIn(box, 'Book the train');
			expect(generalRow.textContent).not.toContain('Draft:');
			expect(generalRow.textContent).toContain('How can I help?');
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
			const box = await openNewTask();

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
			renderChatPage({draftAttachments: [kept]});

			// A chip by its name in the box the message is typed in, its size said on hover.
			const box = await openNewTask();
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));
			// With a space after it, so the caret has text to be in.
			expect(box.textContent).toBe('pricing.md ');
			expect(chipOf('pricing.md')?.parentElement?.getAttribute('title')).toBe('pricing.md · 2 KB');
			// The open chat keeps the last message in the sidebar; the file waits in the composer.
			const generalRow = screen.getByRole('link', {name: /General/, hidden: true});
			expect(generalRow.textContent).not.toContain('Draft:');

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
			});
			const chat = await screen.findByLabelText('Tasks');
			await openNewTask();
			await waitFor(() => expect(chipOf('pricing.md') === null).toBe(false));

			fireEvent.click(screen.getByRole('button', {name: 'Send'}));

			await waitFor(() =>
				expect(screen.getByLabelText('Message').textContent).toBe('Read pricing.md '),
			);
			expect(chipOf('pricing.md') === null).toBe(false);
			expect(within(chat).queryByText(/Read/, {ignore: GOING})).toBeNull();
			expect(calls().filter(([method]) => method === 'DELETE')).toEqual([]);
		});

		test('opens with each file where it sat among the words, and sends the words with a mark for each, in their order', async () => {
			const chart = {...kept, fileId: 'file-2', name: 'chart.png', type: 'image/png'};
			const typed = `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`;
			renderChatPage({draft: typed, draftAttachments: [chart, kept]});

			const box = await openNewTask();
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
			});

			const box = await openNewTask();
			await waitFor(() => expect(box.textContent).toBe('Look at pricing.md '));
			expect(box.lastChild?.nodeType).toBe(Node.TEXT_NODE);
			expect(pageSaysSafeToReload()).toBe(true);
		});

		test('marks a file whole where the selection takes it in, and not where it doesn’t', async () => {
			renderChatPage({
				draft: `Look at ${ATTACHMENT_MARK} today`,
				draftAttachments: [kept],
			});
			const box = await openNewTask();
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
			renderChatPage({draftAttachments: [kept]});
			const box = await openNewTask();
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
			renderChatPage({draftAttachments: [kept, chart]});
			const box = await openNewTask();
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
			renderChatPage();
			const box = await openNewTask();
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

		test('opens a file the person attached in the viewer, and steps through the files of that message there, those deleted since left out', async () => {
			const chart = {...kept, fileId: 'file-2', name: 'chart.png', type: 'image/png', shown: true};
			const old = {...kept, fileId: 'file-3', name: 'old.md', gone: true};
			const sheet = {...kept, fileId: 'file-4', name: 'q3.csv', type: 'text/csv'};
			renderChatPage({
				threads: [pricing],
				views: {
					t1: view(pricing, [
						said(
							'm1',
							'person',
							`See ${ATTACHMENT_MARK} ${ATTACHMENT_MARK} ${ATTACHMENT_MARK} and ${ATTACHMENT_MARK}`,
							[kept, chart, old, sheet],
						),
						said('m2', 'assistant', 'Read them.'),
					]),
				},
				initial: '/acme/chat/general/threads/t1',
			});

			await screen.findByLabelText('Thread');
			const thread = screen.getByLabelText('Thread');
			// A deleted file opens nothing.
			expect(within(thread).getByTitle('old.md was deleted').closest('button')).toBeNull();
			fireEvent.click(within(thread).getByRole('button', {name: 'chart.png'}));

			const viewer = await screen.findByRole('dialog');
			expect(within(viewer).getByText('chart.png · 2 KB · 2 of 3')).toBeTruthy();
			const whole = within(viewer).getByRole('img');
			expect(whole.getAttribute('src')).toBe(
				'/api/orgs/acme/connections/drive-1/files/file-2/content?version=v1',
			);
			expect(whole.getAttribute('alt')).toBe('chart.png');

			// A file that is no picture, as its name, Files a click away.
			fireEvent.keyDown(viewer, {key: 'ArrowRight'});
			expect(within(viewer).getByText('q3.csv · 2 KB · 3 of 3')).toBeTruthy();
			expect(within(viewer).queryByRole('img')).toBeNull();
			expect(within(viewer).getByRole('link', {name: 'Open in Files'}).getAttribute('href')).toBe(
				'/acme/connections/drive-1?file=file-4',
			);
			fireEvent.click(within(viewer).getByRole('button', {name: 'Next file'}));
			expect(within(viewer).getByText('pricing.md · 2 KB · 1 of 3')).toBeTruthy();

			fireEvent.click(within(viewer).getByRole('button', {name: 'Close'}));
			await waitFor(() => expect(viewer.isConnected).toBe(false));
		});
	});
});
