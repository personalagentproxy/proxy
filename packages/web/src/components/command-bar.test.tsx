/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {afterEach, beforeEach, describe, expect, jest, mock, test} from 'bun:test';
import {useState} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {CommandBar} from '@/components/command-bar';
import {testHuman} from '@/test-org';
import {clearWidgetLookups, widgetsAnswer} from '@/test-widgets-api';

const intent = {
	widget: 'new_event',
	fields: [
		{id: 'attendees', name: 'Attendees', values: ['Jacky Doe']},
		{id: 'title', name: 'Title', values: []},
	],
	ms: 140,
};

const connection = (id: string, integrationId: string, account: string): Connection => ({
	id,
	orgId: 'org-1',
	integrationId,
	account,
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
});

const agent = (
	id: string,
	providerId: string,
	name: string,
	revokedAt: string | null = null,
): AgentLogin => ({
	id,
	providerId,
	name,
	username: id,
	shared: false,
	createdById: 'user-1',
	createdBy: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt,
	grants: [],
});

// What is connected and the external agents, as the dialog reads them for the bar: the vault, two
// Google accounts and Notion, and Claude beside a revoked login.
let lists: {connections: Connection[]; agents: AgentLogin[]} = {
	connections: [
		connection('vault-1', 'vault', 'Acme'),
		connection('google-1', 'google', 'me@example.com'),
		connection('google-2', 'google', 'me@home.example'),
		connection('notion-1', 'notion', 'Acme'),
	],
	agents: [
		agent('a1', 'claude', 'Claude'),
		agent('a2', 'chatgpt', 'ChatGPT', '2026-10-02T00:00:00.000Z'),
	],
};

const realFetch = globalThis.fetch;
// `/api/intent`, the widget picked, which each test answers; `/api/intent/fields`, its fields, filled
// in as `intent` and `person` have them unless a test says otherwise; the widgets' own requests go
// to a fake of their api.
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const fieldsMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();

// What the widgets wrote: each request that makes or sends something, with its body.
let written: Array<{path: string; body: unknown}> = [];

function fieldsFor(init?: RequestInit): Promise<Response> {
	const {widget} = JSON.parse(String(init?.body)) as {widget: string};
	const filled = [intent, person].find((one) => one.widget === widget);
	return Promise.resolve(Response.json({fields: filled?.fields ?? [], ms: 1}));
}

// Answers what a test left unanswered once it is over. Every POST is a write on its way to the
// app (lib/writes-in-flight.ts), the bar's questions too, and one left on its way would keep the
// tests after these from ever reloading for a new release.
let endTest: () => void = () => undefined;

// The bar times what it asks by typing (a tick, and a pause), and the tests say what shows at each
// moment of it: time passes only as a test moves it on, or as Testing Library does while it waits,
// so what shows doesn't depend on how fast the machine is.
beforeEach(() => {
	jest.useFakeTimers();
	fetchMock.mockReset();
	fieldsMock.mockReset();
	fieldsMock.mockImplementation((_input, init) => fieldsFor(init));
	written = [];
	const ended = new Promise<Response>((resolve) => {
		endTest = () => resolve(Response.json({}, {status: 503}));
	});
	globalThis.fetch = ((input: string, init?: RequestInit) => {
		if (init?.method === 'POST' && input.includes('/widgets/')) {
			written.push({path: input, body: JSON.parse(String(init.body))});
		}
		const answer = widgetsAnswer(input, init);
		if (answer) {
			return Promise.resolve(answer);
		}
		const asked =
			input === '/api/orgs/acme/intent/fields' ? fieldsMock(input, init) : fetchMock(input, init);
		return Promise.race([asked, ended]);
	}) as typeof fetch;
});

afterEach(async () => {
	cleanup();
	localStorage.clear();
	document.documentElement.className = '';
	jest.useRealTimers();
	endTest();
	await new Promise((resolve) => setTimeout(resolve, 0));
	globalThis.fetch = realFetch;
	clearWidgetLookups();
});

// The bar in an organization without Chat, as the dialog over a page shows it.
function renderBar() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				children: [
					{
						path: '/:org',
						element: (
							<CommandBar
								connections={lists.connections}
								agents={lists.agents}
								personas={null}
								open
								onClose={() => undefined}
							/>
						),
					},
				],
			},
		],
		{initialEntries: ['/acme']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

// Same bar, but closes when `onClose` is called, as the command palette does.
function renderClosableBar() {
	function Bar() {
		const [open, setOpen] = useState(true);
		if (!open) {
			return null;
		}
		return (
			<CommandBar
				connections={lists.connections}
				agents={lists.agents}
				personas={null}
				open
				onClose={() => setOpen(false)}
			/>
		);
	}

	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				children: [{path: '/:org', element: <Bar />}],
			},
		],
		{initialEntries: ['/acme']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

const person = {
	widget: 'find_person',
	fields: [{id: 'person', name: 'Person', values: ['hugo']}],
	ms: 1,
};

// `ms` go by, and what the bar's timers asked is answered.
async function pass(ms: number) {
	await act(async () => {
		jest.advanceTimersByTime(ms);
	});
}

async function typeInto(value: string): Promise<HTMLElement> {
	const input = await screen.findByRole('searchbox', {name: 'Quick actions'});
	fireEvent.change(input, {target: {value}});
	return input;
}

describe('CommandBar', () => {
	test('suggests a quick action while the input is empty, and none once typing starts', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderBar();

		expect(await screen.findByText('Quick actions:')).toBeTruthy();
		expect(screen.getByText('Book lunch with Jacky tomorrow at 1')).toBeTruthy();
		await typeInto('lunch');
		expect(screen.queryByText('Quick actions:')).toBeNull();
	});

	test('opens what is typed into its widget under the input, and nothing else', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderBar();

		await typeInto('lunch with Jacky Doe at Nopa');
		expect(fetchMock).not.toHaveBeenCalled();

		const widget = await screen.findByRole('region', {name: 'New event'});
		expect(await within(widget).findByText(/jacky\.doe@example\.com/)).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/orgs/acme/intent',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({text: 'lunch with Jacky Doe at Nopa'}),
			}),
		);
		expect(fieldsMock).toHaveBeenCalledWith(
			'/api/orgs/acme/intent/fields',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({text: 'lunch with Jacky Doe at Nopa', widget: 'new_event'}),
			}),
		);
		// The raw answer is not shown.
		expect(screen.queryByText(/140 ms/)).toBeNull();
	});

	test('shows the widget as soon as it is picked, and fills it in when its fields come', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		let fields: (response: Response) => void = () => {};
		fieldsMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (fields = resolve)));
		renderBar();

		await typeInto('lunch with Jacky Doe');
		const filling = await screen.findByRole('region', {name: 'New event'});
		expect(within(filling).getByText('Filling in…')).toBeTruthy();

		await waitFor(() => expect(fieldsMock).toHaveBeenCalledTimes(1));
		fields(Response.json({fields: intent.fields, ms: 1}));
		expect(await screen.findByText(/jacky\.doe@example\.com/)).toBeTruthy();
		expect(screen.queryByText('Filling in…')).toBeNull();
	});

	test('the widget on screen, picked again, stays filled in until its new fields come', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderBar();

		await typeInto('lunch with Jacky Doe');
		const widget = await screen.findByRole('region', {name: 'New event'});
		expect(await within(widget).findByText(/jacky\.doe@example\.com/)).toBeTruthy();

		fieldsMock.mockImplementation(() => new Promise<Response>(() => {}));
		await typeInto('lunch with Jacky Doe at Nopa');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await pass(50);

		expect(screen.queryByText('Filling in…')).toBeNull();
		expect(
			within(screen.getByRole('region', {name: 'New event'})).getByText(/jacky\.doe@example\.com/),
		).toBeTruthy();
	});

	test("fields for a widget no longer on screen aren't shown", async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(intent)));
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(person)));
		let fields: (response: Response) => void = () => {};
		fieldsMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (fields = resolve)));
		renderBar();

		await typeInto('lunch with');
		await screen.findByRole('region', {name: 'New event'});
		await typeInto('who is hugo');
		await screen.findByRole('region', {name: 'Person'});

		expect(fieldsMock).toHaveBeenCalledTimes(2);
		fields(Response.json({fields: intent.fields, ms: 1}));
		await pass(50);
		expect(screen.getByRole('region', {name: 'Person'})).toBeTruthy();
		expect(screen.queryByRole('region', {name: 'New event'})).toBeNull();
	});

	test('says what fits no quick action is for an agent, once typing pauses', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderBar();

		await typeInto('summarize my week');
		const unsupported = await screen.findByRole('region', {name: 'Not a quick action (yet)'});
		expect(within(unsupported).getByText(/For anything else, ask Claude/)).toBeTruthy();
	});

	test('says nothing fits while typing goes on past what was asked about', async () => {
		let answer: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
		renderBar();

		await typeInto('what');
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		await typeInto('whats hugos number');
		answer(Response.json({widget: 'none', fields: [], ms: 1}));
		await pass(50);

		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();
	});

	test('waits for typing to pause before saying nothing fits', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderBar();

		await typeInto('summarize my week');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await pass(100);
		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();

		expect(await screen.findByRole('region', {name: 'Not a quick action (yet)'})).toBeTruthy();
	});

	test('text still being typed says nothing, and keeps the widget on screen', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(intent)));
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'incomplete', fields: [], ms: 1})),
		);
		renderBar();

		await typeInto('lunch with Jacky Doe');
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();
		await typeInto('lunch with Jacky Doe and');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await pass(700);

		expect(screen.getByRole('region', {name: 'New event'})).toBeTruthy();
		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();
	});

	test('a start still being typed opens nothing', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'incomplete', fields: [], ms: 1})),
		);
		renderBar();

		await typeInto('find the');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await pass(700);

		expect(screen.queryAllByRole('region')).toEqual([]);
	});

	test('with no agent yet, offers to add one for what fits no quick action', async () => {
		const before = lists;
		lists = {...lists, agents: []};
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderBar();

		await typeInto('summarize my week');
		const unsupported = await screen.findByRole('region', {name: 'Not a quick action (yet)'});
		expect(within(unsupported).getByRole('link', {name: 'Add an agent'}).getAttribute('href')).toBe(
			'/acme/agents/new',
		);
		lists = before;
	});

	test('keeps classifying while typing goes on, and once more with the final text', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderBar();

		const sentence = 'lunch with Jacky Doe at Nopa';
		for (let end = 1; end <= sentence.length; end += 3) {
			await typeInto(sentence.slice(0, end));
			await pass(100);
		}
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

		await typeInto(sentence);
		await waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/orgs/acme/intent',
				expect.objectContaining({body: JSON.stringify({text: sentence})}),
			),
		);
	});

	test('a slow answer never replaces a newer one', async () => {
		let answerFirst: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() => new Promise<Response>((resolve) => (answerFirst = resolve)),
		);
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(intent)));
		renderBar();

		await typeInto('who is');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await typeInto('lunch with Jacky');
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();

		answerFirst(Response.json(person));
		await pass(50);
		expect(screen.getByRole('region', {name: 'New event'})).toBeTruthy();
		expect(screen.queryByRole('region', {name: 'Person'})).toBeNull();
	});

	test("a widget's action types what it leads to into the input, and asks about that", async () => {
		fetchMock.mockImplementation((_input: string, init?: RequestInit) =>
			Promise.resolve(
				Response.json(String(init?.body).includes('write an email') ? intent : person),
			),
		);
		renderBar();

		const input = await typeInto('who is hugo');
		const widget = await screen.findByRole('region', {name: 'Person'});
		fireEvent.click(
			await within(widget).findByRole('button', {name: 'Write to hugo.brandt@example.com'}),
		);

		expect(input).toHaveProperty('value', 'write an email to hugo.brandt@example.com');
		await waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/orgs/acme/intent',
				expect.objectContaining({
					body: JSON.stringify({text: 'write an email to hugo.brandt@example.com'}),
				}),
			),
		);
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();
	});

	test('Enter in the input presses the main button of the card on screen, which says so', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'write_email', ms: 1})),
		);
		fieldsMock.mockImplementation(() =>
			Promise.resolve(
				Response.json({
					fields: [
						{id: 'to', name: 'To', values: ['hugo']},
						{id: 'subject', name: 'Subject', values: ['Lunch']},
						{id: 'body', name: 'Message', values: ['Free on Tuesday?']},
					],
					ms: 1,
				}),
			),
		);
		renderBar();

		const input = await typeInto('email hugo about lunch on tuesday');
		const card = await screen.findByRole('region', {name: 'Write email'});
		const send = await within(card).findByRole('button', {name: 'Send email'});
		await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
		expect(send.querySelector('svg')).not.toBeNull();
		expect(written).toEqual([]);
		fireEvent.keyDown(input, {key: 'Enter'});

		expect(await within(card).findByText('Sent')).toBeTruthy();
		expect(written).toMatchObject([
			{path: '/api/orgs/acme/widgets/emails', body: {subject: 'Lunch', send: true}},
		]);
	});

	test('Enter pressed before a card shows never presses its button: the card shows, to be looked over, and Enter then does', async () => {
		let answer: (response: Response) => void = () => {};
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					answer = resolve;
				}),
		);
		fieldsMock.mockImplementation(() =>
			Promise.resolve(
				Response.json({
					fields: [
						{id: 'to', name: 'To', values: ['hugo']},
						{id: 'subject', name: 'Subject', values: ['Lunch']},
						{id: 'body', name: 'Message', values: ['Free on Tuesday?']},
					],
					ms: 1,
				}),
			),
		);
		renderBar();

		const input = await typeInto('email hugo about lunch on tuesday');
		fireEvent.keyDown(input, {key: 'Enter'});
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		answer(Response.json({widget: 'write_email', ms: 1}));

		const card = await screen.findByRole('region', {name: 'Write email'});
		const send = await within(card).findByRole('button', {name: 'Send email'});
		await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
		expect(written).toEqual([]);

		fireEvent.keyDown(input, {key: 'Enter'});
		expect(await within(card).findByText('Sent')).toBeTruthy();
		expect(written).toHaveLength(1);
	});

	test("shows the api's reason when classifying isn't set up", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					error: 'unavailable',
					message: 'Quick actions are not set up: set `TYPESAFE_API_KEY` and `OPENROUTER_KEY`.',
				},
				{status: 503},
			),
		);
		renderBar();

		await typeInto('who is hugo');

		expect(
			await screen.findByText(
				'Quick actions are not set up: set `TYPESAFE_API_KEY` and `OPENROUTER_KEY`.',
			),
		).toBeTruthy();
	});

	test('toggles the theme from its row on Enter and closes the bar', async () => {
		localStorage.setItem('proxy-ui-theme', 'light');
		renderClosableBar();

		const input = await typeInto('theme');
		const row = await screen.findByRole('option', {name: /Toggle theme/});
		expect(row.querySelector('svg.lucide-sun')).not.toBeNull();
		fireEvent.keyDown(input, {key: 'Enter'});

		await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
		expect(localStorage.getItem('proxy-ui-theme')).toBe('dark');
		expect(screen.queryByRole('searchbox', {name: 'Quick actions'})).toBeNull();
	});

	test('toggles the theme from its row on click and closes the bar', async () => {
		localStorage.setItem('proxy-ui-theme', 'light');
		renderClosableBar();

		await typeInto('theme');
		const row = await screen.findByRole('option', {name: /Toggle theme/});
		fireEvent.click(row);

		await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
		expect(localStorage.getItem('proxy-ui-theme')).toBe('dark');
		expect(screen.queryByRole('searchbox', {name: 'Quick actions'})).toBeNull();
	});
});
