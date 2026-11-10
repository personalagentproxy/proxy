/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider, useLocation} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import {HomePage} from '@/pages/home-page';
import {later} from '@/lib/loader-utils';
import {testHuman, testOrg} from '@/test-org';
import {clearWidgetLookups} from '@/test-widgets-api';

const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, name: string, shared: boolean): ChatPersona {
	return {
		id,
		name,
		shared,
		mayChange: true,
		look,
		color: 'blue',
		harness: 'proxy',
		chatModel: 'claude',
		lastMessage: null,
		draft: null,
		createdAt: '2026-10-20T10:00:00Z',
	};
}

const granola: Connection = {
	id: 'granola-1',
	orgId: 'org-1',
	integrationId: 'granola',
	account: 'me@example.com',
	ownerUserId: 'user-1',
	owner: 'Alex',
	sharedWithEveryone: false,
	sharedWith: [],
	shared: false,
	builtIn: false,
	defaults: [],
	tools: null,
	name: null,
	unavailable: [],
	signInNeeded: false,
};

const claude: AgentLogin = {
	id: 'a1',
	providerId: 'claude',
	name: 'Claude',
	username: 'a1',
	shared: false,
	createdById: 'user-1',
	createdBy: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

const personas = [persona('finance', 'Finance', false), persona('general', 'General', true)];

// What the api is asked, each request with its body, and what it answers: the widget picked for
// what is typed and its fields as each test sets them.
type Asked = {method: string; path: string; body: Record<string, unknown> | null};
let asked: Asked[] = [];
let picked: {widget: string} | Promise<{widget: string}> = {widget: 'none'};
let fields: Array<{id: string; name: string; values: string[]}> = [];
// Whether the organization has Chat.
let chat = true;
// Whether the api refuses a message to an agent.
let refusesMessages = false;

const realFetch = globalThis.fetch;

async function answer(path: string, method: string): Promise<unknown> {
	if (path.endsWith('/intent')) {
		return {...(await picked), ms: 1};
	}
	if (path.endsWith('/intent/fields')) {
		return {fields, ms: 1};
	}
	if (path.endsWith('/chat/personas') && method === 'GET') {
		return {personas, harnesses: []};
	}
	if (path.endsWith('/chat/personas') && method === 'POST') {
		return {persona: persona('made', 'Stretch reminders', false)};
	}
	if (path.endsWith('/messages')) {
		return {
			entry: {id: 'e1', kind: 'person', text: '', isError: false, at: '2026-10-20T10:00:00Z'},
		};
	}
	if (path.endsWith('/chat/answers')) {
		return {answers: []};
	}
	if (path.endsWith('/connections')) {
		return {connections: [granola]};
	}
	if (path.endsWith('/agents')) {
		return {agents: [claude]};
	}
	return {};
}

beforeEach(() => {
	asked = [];
	picked = {widget: 'none'};
	fields = [];
	chat = true;
	refusesMessages = false;
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
		asked.push({method, path: input, body});
		if (refusesMessages && input.endsWith('/messages')) {
			return Response.json({error: 'unavailable', message: 'Try again later.'}, {status: 503});
		}
		return Response.json(await answer(input, method));
	}) as typeof fetch;
});

afterEach(async () => {
	// A dialog still up is closed first, and one on its way out waited for: taken away before it
	// has gone, it leaves the document behind it marked as hidden, and the next test's dialog
	// with it.
	const close = screen.queryByRole('button', {name: 'Close'});
	if (close) {
		fireEvent.click(close);
	}
	await waitFor(
		() => expect(document.querySelector('[data-slot="dialog-content"]') === null).toBe(true),
		SOON,
	);
	globalThis.fetch = realFetch;
	clearWidgetLookups();
	cleanup();
});

// A page that says where the app is, in place of the pages the bar leads to.
function Where() {
	return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderApp(entry = '/acme/activity') {
	const human = testHuman({...testOrg, experiments: chat ? ['harness'] : []});
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => human,
				element: <HumanSide />,
				children: [
					{
						path: '/:org',
						loader: later(async () => ({connections: [granola], agents: [claude], activity: null})),
						element: <HomePage />,
					},
					{path: '/:org/*', element: <Where />},
					{path: '/account', element: <Where />},
				],
			},
		],
		{initialEntries: [entry]},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

async function where(): Promise<string | null> {
	return (await screen.findByTestId('where')).textContent;
}

function pressShortcut() {
	fireEvent.keyDown(window, {key: 'k', ctrlKey: true});
}

async function openBar(): Promise<HTMLElement> {
	await where();
	pressShortcut();
	return screen.findByRole('searchbox', {name: 'Quick actions'}, SOON);
}

// A card shows once what is typed was asked about, and one that says no quick action fits once
// typing has paused beside: longer than a query waits by itself, on a busy machine.
const SOON = {timeout: 5000};

function cardNamed(name: string): Promise<HTMLElement> {
	return screen.findByRole('region', {name}, SOON);
}

// The app has gone to `path`, as the page there says.
function arrivedAt(path: string): Promise<void> {
	return waitFor(() => expect(screen.queryByTestId('where')?.textContent).toBe(path), SOON);
}

function barIsOpen(): boolean {
	return document.querySelector('input[type="search"]') !== null;
}

function rows(): string[] {
	return screen.queryAllByRole('option').map((row) => row.textContent ?? '');
}

function posts(suffix: string): Asked[] {
	return asked.filter((one) => one.method === 'POST' && one.path.endsWith(suffix));
}

describe('the command bar over any page', () => {
	test('opens on the shortcut, listing where to go before anything is typed, and closes on it again', async () => {
		renderApp();
		expect(await where()).toBe('/acme/activity');
		expect(barIsOpen()).toBe(false);

		await openBar();
		await waitFor(() => expect(rows().some((row) => row.startsWith('Granola'))).toBe(true));
		expect(rows().slice(0, 2)).toEqual(['HomePage', 'ChatPage']);
		expect(rows().some((row) => row.startsWith('Finance'))).toBe(true);
		expect(rows().some((row) => row.startsWith('Claude'))).toBe(true);

		pressShortcut();
		// Whether it is there, never the element itself: an expectation that fails on an element
		// writes the whole document out to say so, each time it is tried.
		await waitFor(() => expect(barIsOpen()).toBe(false));
	});

	test('is also opened from the sidebar', async () => {
		renderApp();
		await where();

		fireEvent.click(screen.getByRole('button', {name: 'Search'}));

		expect(await screen.findByRole('searchbox', {name: 'Quick actions'})).toBeTruthy();
	});

	test('goes where what is typed leads on Enter, the arrow keys moving the row it opens, and closes', async () => {
		renderApp();
		const input = await openBar();
		await waitFor(() => expect(rows().some((row) => row.startsWith('Granola'))).toBe(true));

		fireEvent.change(input, {target: {value: 'fin'}});
		expect(rows()).toEqual(['FinanceChat']);
		fireEvent.change(input, {target: {value: 'a'}});
		const first = screen.getAllByRole('option')[0];
		expect(first?.getAttribute('aria-selected')).toBe('true');
		fireEvent.keyDown(input, {key: 'ArrowDown'});
		expect(first?.getAttribute('aria-selected')).toBe('false');
		fireEvent.keyDown(input, {key: 'ArrowUp'});

		fireEvent.change(input, {target: {value: 'gran'}});
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/connections/granola-1');
		expect(barIsOpen()).toBe(false);
		// Somewhere to go is found without asking the api what was meant.
		expect(posts('/intent')).toEqual([]);
	});

	test('a click on a row opens it', async () => {
		renderApp();
		const input = await openBar();
		fireEvent.change(input, {target: {value: 'members'}});

		fireEvent.click(screen.getByRole('option', {name: /Members/}));

		await arrivedAt('/acme/members');
	});

	test('what no quick action does is a message to General, sent on Enter, which leads to the conversation', async () => {
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'plan my trip to Lisbon in March'}});
		const card = await cardNamed('Send to an agent');
		expect(within(card).getByRole('combobox', {name: 'Agent'}).textContent).toContain('General');
		expect(card.textContent).toContain('Send this to General');
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/chat/general');
		expect(posts('/chat/personas/general/messages').map((one) => one.body)).toEqual([
			{text: 'plan my trip to Lisbon in March'},
		]);
		expect(barIsOpen()).toBe(false);
	});

	test('it goes to the agent the text names, or the one picked', async () => {
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'what does finance think of the offer'}});
		const card = await cardNamed('Send to an agent');
		expect(within(card).getByRole('combobox', {name: 'Agent'}).textContent).toContain('Finance');
		fireEvent.click(within(card).getByRole('button', {name: 'Send'}));

		await arrivedAt('/acme/chat/finance');
		expect(posts('/chat/personas/finance/messages')).toHaveLength(1);
	});

	test('Enter pressed before the answer has come sends once it says no quick action does it, whole or not', async () => {
		let resolve: (value: {widget: string}) => void = () => undefined;
		picked = new Promise((resolved) => {
			resolve = resolved;
		});
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'hello there'}});
		fireEvent.keyDown(input, {key: 'Enter'});
		expect(await screen.findByRole('status', {name: 'Working it out'}, SOON)).toBeTruthy();
		expect(posts('/messages')).toEqual([]);
		resolve({widget: 'incomplete'});

		await arrivedAt('/acme/chat/general');
		expect(posts('/chat/personas/general/messages').map((one) => one.body)).toEqual([
			{text: 'hello there'},
		]);
	});

	test('a text said to an agent by name is a message to it of what follows the name, and no quick action is looked for', async () => {
		picked = {widget: 'show_calendar'};
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'ask Finance what is on my calendar tomorrow'}});
		const card = await cardNamed('Send to an agent');
		expect(within(card).getByRole('combobox', {name: 'Agent'}).textContent).toContain('Finance');
		// The sentence says what is sent, which is what follows the agent's name.
		expect(card.textContent).toContain('Send what is on my calendar tomorrow to');
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/chat/finance');
		expect(posts('/chat/personas/finance/messages').map((one) => one.body)).toEqual([
			{text: 'what is on my calendar tomorrow'},
		]);
		expect(posts('/intent')).toEqual([]);
	});

	test('a wish for a new agent opens into one to make, named and told what to do, which Enter makes and leads to', async () => {
		picked = {widget: 'new_agent'};
		fields = [
			{id: 'agentName', name: 'Name', values: ['Stretch reminders']},
			{id: 'agentTask', name: 'Task', values: ['Remind me to stretch every hour.']},
		];
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {
			target: {value: 'add an agent that reminds me to stretch every hour'},
		});
		const card = await cardNamed('New agent');
		const name = await within(card).findByRole('textbox', {name: 'Name'});
		expect((name as HTMLInputElement).value).toBe('Stretch reminders');
		expect(
			(within(card).getByRole('textbox', {name: 'What it does'}) as HTMLTextAreaElement).value,
		).toBe('Remind me to stretch every hour.');
		fireEvent.change(name, {target: {value: 'Stretch'}});
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/chat/made');
		expect(posts('/chat/personas').map((one) => one.body)).toMatchObject([{name: 'Stretch'}]);
		expect(posts('/chat/personas/made/messages').map((one) => one.body)).toEqual([
			{text: 'Remind me to stretch every hour.'},
		]);
	});

	test('Enter pressed before a new agent shows makes it as soon as it is filled in, once', async () => {
		picked = {widget: 'new_agent'};
		fields = [
			{id: 'agentName', name: 'Name', values: ['Finance watch']},
			{id: 'agentTask', name: 'Task', values: []},
		];
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'create an agent for my finances'}});
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/chat/made');
		expect(posts('/chat/personas').map((one) => one.body)).toMatchObject([{name: 'Finance watch'}]);
		// With nothing to tell it yet, it is made and opened, and told nothing.
		expect(posts('/messages')).toEqual([]);
	});

	test('a message the api refuses stays in the bar, with why, to send again', async () => {
		refusesMessages = true;
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'plan my trip to Lisbon in March'}});
		const card = await cardNamed('Send to an agent');
		fireEvent.keyDown(input, {key: 'Enter'});

		expect(await within(card).findByText('Try again later.')).toBeTruthy();
		expect(screen.getByTestId('where').textContent).toBe('/acme/activity');
		refusesMessages = false;
		fireEvent.keyDown(input, {key: 'Enter'});
		await arrivedAt('/acme/chat/general');
		expect(posts('/chat/personas/general/messages')).toHaveLength(2);
	});

	test('a new agent whose first message the api refuses is made all the same, the message kept in its conversation as typed', async () => {
		refusesMessages = true;
		picked = {widget: 'new_agent'};
		fields = [
			{id: 'agentName', name: 'Name', values: ['Stretch reminders']},
			{id: 'agentTask', name: 'Task', values: ['Remind me to stretch every hour.']},
		];
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'add an agent that reminds me to stretch'}});
		const card = await cardNamed('New agent');
		await within(card).findByRole('textbox', {name: 'Name'});
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/chat/made');
		expect(
			asked
				.filter((one) => one.method === 'PUT' && one.path.endsWith('/made/draft'))
				.map((one) => one.body),
		).toEqual([{text: 'Remind me to stretch every hour.'}]);
	});

	test('a new agent without a name waits for one', async () => {
		picked = {widget: 'new_agent'};
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'new agent'}});
		const card = await cardNamed('New agent');
		const create = await within(card).findByRole('button', {name: 'Create agent'});
		expect((create as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(input, {key: 'Enter'});
		expect(posts('/chat/personas')).toEqual([]);

		fireEvent.change(within(card).getByRole('textbox', {name: 'Name'}), {target: {value: 'Penny'}});
		fireEvent.click(create);

		await arrivedAt('/acme/chat/made');
		expect(posts('/chat/personas').map((one) => one.body)).toMatchObject([{name: 'Penny'}]);
	});

	test('Enter leaves a quick action on screen for what is typed alone', async () => {
		picked = {widget: 'calculate'};
		fields = [{id: 'expression', name: 'Calculation', values: ['2 + 2']}];
		renderApp();
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'what is 2 + 2'}});
		await cardNamed('Math');
		await waitFor(() => expect(posts('/intent/fields')).toHaveLength(1));
		const before = asked.length;
		fireEvent.keyDown(input, {key: 'Enter'});

		expect(await where()).toBe('/acme/activity');
		expect(asked.length).toBe(before);
		expect(screen.getByRole('region', {name: 'Math'})).toBeTruthy();
	});

	test('without Chat, it goes places and does quick actions, and what none does is said to be an agent’s', async () => {
		chat = false;
		renderApp();
		const input = await openBar();
		await waitFor(() => expect(rows().some((row) => row.startsWith('Granola'))).toBe(true));
		expect(rows().some((row) => row.startsWith('Chat'))).toBe(false);

		fireEvent.change(input, {target: {value: 'plan my trip to Lisbon in March'}});
		fireEvent.keyDown(input, {key: 'Enter'});

		expect(await cardNamed('Not a quick action (yet)')).toBeTruthy();
		expect(asked.some((one) => one.path.includes('/chat/personas'))).toBe(false);
		expect(await where()).toBe('/acme/activity');
	});

	test('on the account page, which is no organization’s, it goes to the pages of the person’s first and classifies nothing', async () => {
		renderApp('/account');
		const input = await openBar();

		fireEvent.change(input, {target: {value: 'plan my trip to Lisbon in March'}});
		fireEvent.keyDown(input, {key: 'Enter'});
		fireEvent.change(input, {target: {value: 'activity'}});
		fireEvent.keyDown(input, {key: 'Enter'});

		await arrivedAt('/acme/activity');
		expect(posts('/intent')).toEqual([]);
	});
});

describe('the command bar on the home page', () => {
	test('takes the cursor on the shortcut, instead of opening over the page, and goes places as it does there', async () => {
		renderApp('/acme');
		const input = await screen.findByRole('searchbox', {name: 'Quick actions'});
		input.blur();
		expect(document.activeElement).not.toBe(input);

		pressShortcut();

		expect(document.activeElement).toBe(input);
		expect(screen.getAllByRole('searchbox', {name: 'Quick actions'})).toHaveLength(1);
		// Nowhere to go is listed before anything is typed, on the page.
		expect(rows()).toEqual([]);

		fireEvent.change(input, {target: {value: 'gran'}});
		expect(rows()).toEqual(['Granolame@example.comConnection']);
		fireEvent.keyDown(input, {key: 'Enter'});
		await arrivedAt('/acme/connections/granola-1');
	});
});
