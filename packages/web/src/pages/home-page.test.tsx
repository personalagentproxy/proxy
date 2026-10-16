/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import type {ActivitySummary} from '@/client/schemas';
import {HomePage} from '@/pages/home-page';
import {clearWidgetLookups, widgetsAnswer} from '@/test-widgets-api';

const intent = {
	widget: 'new_event',
	fields: [
		{id: 'attendees', name: 'Attendees', values: ['Jacky Doe']},
		{id: 'title', name: 'Title', values: []},
	],
	ms: 140,
};

const connection = (id: string, integrationId: string, account: string) => ({
	id,
	integrationId,
	account,
	defaults: [],
	tools: null,
	name: null,
	unavailable: [],
});

const agent = (id: string, providerId: string, name: string, revokedAt: string | null = null) => ({
	id,
	providerId,
	name,
	username: id,
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt,
	grants: [],
});

// A fortnight of activity: Claude's on Monday and Tuesday, the person's own on Tuesday, two of
// Claude's refused, and the past week's events made and emails sent.
const activity: ActivitySummary = {
	today: '2026-10-16',
	days: [
		{day: '2026-10-02', agentId: 'a1', count: 1, denied: 0},
		{day: '2026-10-12', agentId: 'a1', count: 5, denied: 2},
		{day: '2026-10-13', agentId: 'a1', count: 8, denied: 0},
		{day: '2026-10-13', agentId: null, count: 2, denied: 0},
	],
	week: [
		{
			connectionId: 'google-1',
			collectionId: 'emails',
			action: 'view',
			outcome: 'allowed',
			count: 9,
		},
		{
			connectionId: 'google-1',
			collectionId: 'events',
			action: 'create',
			outcome: 'allowed',
			count: 2,
		},
		{connectionId: 'google-1', collectionId: 'emails', action: 'send', outcome: 'denied', count: 2},
	],
};

// What the home route's loader answers: the connections and agent logins, for the logos, and
// what was done, for the graph.
let home: {
	connections: ReturnType<typeof connection>[];
	agents: ReturnType<typeof agent>[];
	activity: ActivitySummary | null;
} = {
	connections: [
		connection('info-1', 'info', 'Acme'),
		connection('google-1', 'google', 'me@example.com'),
		connection('google-2', 'google', 'me@home.example'),
		connection('notion-1', 'notion', 'Acme'),
	],
	agents: [
		agent('a1', 'claude', 'Claude'),
		agent('a2', 'chatgpt', 'ChatGPT', '2026-10-02T00:00:00.000Z'),
	],
	activity,
};

const realFetch = globalThis.fetch;
// `/api/intent`, which each test answers; the widgets' own requests go to a fake of their api.
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
	fetchMock.mockReset();
	globalThis.fetch = ((input: string, init?: RequestInit) => {
		const answer = widgetsAnswer(input, init);
		return answer ? Promise.resolve(answer) : fetchMock(input, init);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearWidgetLookups();
	cleanup();
});

function renderHomePage() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({
					user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
					onboarded: true,
				}),
				element: <HumanSide />,
				children: [{path: '/', loader: () => home, element: <HomePage />}],
			},
		],
		{initialEntries: ['/']},
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

async function typeInto(value: string): Promise<HTMLElement> {
	const input = await screen.findByRole('searchbox', {name: 'Quick actions'});
	fireEvent.change(input, {target: {value}});
	return input;
}

describe('HomePage', () => {
	test('shows the sources and agents connected under the input, Information and revoked logins left out', async () => {
		renderHomePage();

		const sources = await screen.findByRole('link', {name: '3 sources'});
		expect(sources.getAttribute('href')).toBe('/connections');
		expect(screen.getByRole('link', {name: '1 agent'}).getAttribute('href')).toBe('/agents');
	});

	test('with nothing connected, leads to connecting a source and adding an agent', async () => {
		const before = home;
		home = {connections: [connection('info-1', 'info', 'Acme')], agents: [], activity: null};
		renderHomePage();

		expect((await screen.findByRole('link', {name: 'Connect a source'})).getAttribute('href')).toBe(
			'/connections/new',
		);
		expect(screen.getByRole('link', {name: 'Add an agent'}).getAttribute('href')).toBe(
			'/agents/new',
		);
		home = before;
	});

	test('graphs what was done each day, each busy day leading to its part of the log', async () => {
		renderHomePage();

		const tuesday = await screen.findByRole('link', {name: /Oct 13: 10 requests/});
		expect(tuesday.getAttribute('href')).toBe('/activity?day=2026-10-13');
		expect(screen.getByRole('region', {name: 'Activity'})).toBeTruthy();
		expect(
			screen.getByText('13 requests in the past week: created 2 events, viewed 9 emails', {
				exact: false,
			}),
		).toBeTruthy();
		expect(screen.getByRole('link', {name: '2 blocked'}).getAttribute('href')).toBe(
			'/activity?outcome=denied',
		);

		fireEvent.mouseEnter(tuesday);
		const tooltip = screen.getByRole('tooltip');
		expect(within(tooltip).getByText('Claude')).toBeTruthy();
		expect(within(tooltip).getByText('You')).toBeTruthy();
	});

	test('shows the graph before there is any activity', async () => {
		const before = home;
		home = {...home, activity: {today: '2026-10-16', days: [], week: []}};
		renderHomePage();

		expect(await screen.findByRole('region', {name: 'Activity'})).toBeTruthy();
		expect(screen.getByText('Your agents’ activity will show up here')).toBeTruthy();
		home = before;
	});

	test('suggests a quick action while the input is empty, and none once typing starts', async () => {
		fetchMock.mockResolvedValue(Response.json(intent));
		renderHomePage();

		expect(await screen.findByText('Quick actions:')).toBeTruthy();
		expect(screen.getByText('Book lunch with Jacky tomorrow at 1')).toBeTruthy();
		await typeInto('lunch');
		expect(screen.queryByText('Quick actions:')).toBeNull();
	});

	test('opens what is typed into its widget under the input, and nothing else', async () => {
		fetchMock.mockResolvedValue(Response.json(intent));
		renderHomePage();

		await typeInto('lunch with Jacky Doe at Nopa');
		expect(fetchMock).not.toHaveBeenCalled();

		const widget = await screen.findByRole('region', {name: 'New event'});
		expect(await within(widget).findByText(/jacky\.doe@example\.com/)).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/intent',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({text: 'lunch with Jacky Doe at Nopa'}),
			}),
		);
		// The raw answer is not shown.
		expect(screen.queryByText(/140 ms/)).toBeNull();
	});

	test('says what fits no quick action is for an agent, once typing pauses', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderHomePage();

		await typeInto('summarize my week');
		const unsupported = await screen.findByRole('region', {name: 'Not a quick action (yet)'});
		expect(within(unsupported).getByText(/For anything else, ask Claude/)).toBeTruthy();
	});

	test('says nothing fits while typing goes on past what was asked about', async () => {
		let answer: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
		renderHomePage();

		await typeInto('what');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await typeInto('whats hugos number');
		answer(Response.json({widget: 'none', fields: [], ms: 1}));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();
	});

	test('waits for typing to pause before saying nothing fits', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderHomePage();

		await typeInto('summarize my week');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();

		expect(await screen.findByRole('region', {name: 'Not a quick action (yet)'})).toBeTruthy();
	});

	test('text still being typed says nothing, and keeps the widget on screen', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(intent)));
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'incomplete', fields: [], ms: 1})),
		);
		renderHomePage();

		await typeInto('lunch with Jacky Doe');
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();
		await typeInto('lunch with Jacky Doe and');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(screen.getByRole('region', {name: 'New event'})).toBeTruthy();
		expect(screen.queryByRole('region', {name: 'Not a quick action (yet)'})).toBeNull();
	});

	test('a start still being typed opens nothing', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'incomplete', fields: [], ms: 1})),
		);
		renderHomePage();

		await typeInto('find the');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(
			screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
		).toEqual(['Activity']);
	});

	test('with no agent yet, offers to add one for what fits no quick action', async () => {
		const before = home;
		home = {...home, agents: []};
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({widget: 'none', fields: [], ms: 1})),
		);
		renderHomePage();

		await typeInto('summarize my week');
		const unsupported = await screen.findByRole('region', {name: 'Not a quick action (yet)'});
		expect(within(unsupported).getByRole('link', {name: 'Add an agent'}).getAttribute('href')).toBe(
			'/agents/new',
		);
		home = before;
	});

	test('keeps classifying while typing goes on, and once more with the final text', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderHomePage();

		const sentence = 'lunch with Jacky Doe at Nopa';
		for (let end = 1; end <= sentence.length; end += 3) {
			await typeInto(sentence.slice(0, end));
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

		await typeInto(sentence);
		await waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/intent',
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
		renderHomePage();

		await typeInto('who is');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await typeInto('lunch with Jacky');
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();

		answerFirst(Response.json(person));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole('region', {name: 'New event'})).toBeTruthy();
		expect(screen.queryByRole('region', {name: 'Person'})).toBeNull();
	});

	test('the Esc key in the input row folds the widget away too', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(Response.json(intent)));
		renderHomePage();

		expect(screen.queryByRole('button', {name: 'Dismiss'})).toBeNull();
		const input = await typeInto('lunch with Jacky');
		await screen.findByRole('region', {name: 'New event'});
		fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
		expect(input).toHaveProperty('value', '');
		expect(screen.queryByText('Esc to dismiss')).toBeNull();
	});

	test('Esc folds the widget away, and typing anew never shows the last one', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json(intent)));
		let answerSecond: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() => new Promise<Response>((resolve) => (answerSecond = resolve)),
		);
		renderHomePage();

		const input = await typeInto('lunch with Jacky');
		const widget = await screen.findByRole('region', {name: 'New event'});
		fireEvent.keyDown(input, {key: 'Escape'});
		expect(input).toHaveProperty('value', '');
		expect(widget.closest('[inert]')).not.toBeNull();

		await typeInto('who is hugo');
		expect(screen.queryByRole('region', {name: 'New event'})).toBeNull();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		answerSecond(Response.json(person));
		const opened = await screen.findByRole('region', {name: 'Person'});
		expect(opened.closest('[inert]')).toBeNull();
	});

	test("a widget's action types what it leads to into the input, and asks about that", async () => {
		fetchMock.mockImplementation((_input: string, init?: RequestInit) =>
			Promise.resolve(
				Response.json(String(init?.body).includes('write an email') ? intent : person),
			),
		);
		renderHomePage();

		const input = await typeInto('who is hugo');
		const widget = await screen.findByRole('region', {name: 'Person'});
		fireEvent.click(
			await within(widget).findByRole('button', {name: 'Write to hugo.brandt@example.com'}),
		);

		expect(input).toHaveProperty('value', 'write an email to hugo.brandt@example.com');
		await waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/intent',
				expect.objectContaining({
					body: JSON.stringify({text: 'write an email to hugo.brandt@example.com'}),
				}),
			),
		);
		expect(await screen.findByRole('region', {name: 'New event'})).toBeTruthy();
	});

	test("shows the api's reason when classifying isn't set up", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{error: 'unavailable', message: 'The home page is not set up: set `OPENROUTER_KEY`.'},
				{status: 503},
			),
		);
		renderHomePage();

		await typeInto('who is hugo');

		expect(
			await screen.findByText('The home page is not set up: set `OPENROUTER_KEY`.'),
		).toBeTruthy();
	});
});
