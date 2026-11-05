/// <reference types="bun" />

import type {ChatPersona} from '@proxy/contracts/harness';
import type {Experiment} from '@proxy/utils';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {useUnread} from '@/hooks/use-unread';
import {testHuman, testOrg} from '@/test-org';

const realFetch = globalThis.fetch;
const realHasFocus = document.hasFocus.bind(document);
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

const LIST = '/api/orgs/acme/chat/personas';
const READ_GENERAL = '/api/orgs/acme/chat/personas/general/read';

function persona(id: string, unread: boolean): ChatPersona {
	return {
		id,
		name: id,
		mayChange: false,
		look,
		color: 'blue',
		chatModel: null,
		unread,
		lastMessage: {kind: 'person', text: 'Thanks', at: '2026-10-21T10:00:00Z'},
		lastAnswer: {id: `${id}-answer`, text: 'Done.'},
	};
}

// The api: the personas as `listed` has them, and a read that lands; `read` is called with what
// it was sent.
function serve(listed: () => ChatPersona[], read: (body: string) => void = () => undefined) {
	fetchMock.mockImplementation((input, init) => {
		if (input.endsWith('/read')) {
			read(String(init?.body));
			return Promise.resolve(new Response(null, {status: 204}));
		}
		return Promise.resolve(Response.json({personas: listed()}));
	});
}

function readCalls() {
	return fetchMock.mock.calls.filter(([url]) => url === READ_GENERAL);
}

// A page that shows what the provider has, and shows a conversation, or none, on request.
function Consumer() {
	const unread = useUnread();
	return (
		<div>
			<span data-testid="count">{unread.unreadIds.size}</span>
			<span data-testid="ids">{[...unread.unreadIds].join(',')}</span>
			<button
				type="button"
				onClick={() => unread.setViewing({personaId: 'general', answerId: 'general-answer'})}
			>
				View General
			</button>
			<button type="button" onClick={() => unread.setViewing(null)}>
				Leave
			</button>
		</div>
	);
}

function renderProvider(experiments: Experiment[] = ['harness'], entry = '/acme') {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, experiments}),
				element: <HumanSide />,
				children: [
					{path: '/account', element: <Consumer />},
					{path: '/:org', element: <Consumer />},
				],
			},
		],
		{initialEntries: [entry]},
	);
	return render(<RouterProvider router={router} />);
}

const setBadge = mock((_count: number) => undefined);
const notifyDesktop = mock(
	(_notice: {title: string; body: string; path: string; tag: string}) => undefined,
);
const realNow = Date.now;
// How far the clock is moved on, so a poll asked for by the page coming into view is not too soon.
let later = 0;

function moveOn(ms: number) {
	later += ms;
}

function comeBack() {
	moveOn(6000);
	act(() => {
		window.dispatchEvent(new Event('focus'));
	});
}

function listCalls() {
	return fetchMock.mock.calls.filter(([url]) => url === LIST);
}

beforeEach(() => {
	fetchMock.mockReset();
	serve(() => [persona('general', true), persona('finance', true)]);
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
	document.hasFocus = () => true;
	setBadge.mockClear();
	notifyDesktop.mockClear();
	later = 0;
	Date.now = () => realNow() + later;
	localStorage.clear();
	window.personalAgentProxyDesktop = {
		updateReady: () => Promise.resolve(null),
		onUpdateReady: () => () => undefined,
		restart: () => undefined,
		notify: notifyDesktop,
		onOpenPath: () => () => undefined,
		setBadge,
	};
	document.title = 'Personal Agent Proxy';
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
	document.hasFocus = realHasFocus;
	Date.now = realNow;
	delete window.personalAgentProxyDesktop;
});

describe('UnreadProvider', () => {
	test('asks for the conversations, counts those with something unread, in the title and on the badge, less the one looked at, which it reads up to the answer shown', async () => {
		let generalRead = false;
		const bodies: string[] = [];
		serve(
			() => [persona('general', !generalRead), persona('finance', true)],
			(body) => {
				bodies.push(body);
				generalRead = true;
			},
		);
		renderProvider();

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('2');
		});
		expect(fetchMock).toHaveBeenCalledWith(LIST, expect.anything());
		expect(screen.getByTestId('ids').textContent).toBe('general,finance');
		expect(document.title).toBe('(2) Personal Agent Proxy');
		expect(setBadge).toHaveBeenLastCalledWith(2);

		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		expect(screen.getByTestId('count').textContent).toBe('1');
		expect(screen.getByTestId('ids').textContent).toBe('finance');
		await waitFor(() => {
			expect(bodies).toEqual([JSON.stringify({entryId: 'general-answer'})]);
		});

		// Once the read lands the conversations are asked about again, so leaving leaves it read.
		await waitFor(() => {
			expect(fetchMock.mock.calls.filter(([url]) => url === LIST)).toHaveLength(2);
		});
		act(() => {
			screen.getByRole('button', {name: 'Leave'}).click();
		});
		await waitFor(() => {
			expect(screen.getByTestId('ids').textContent).toBe('finance');
		});
		expect(document.title).toBe('(1) Personal Agent Proxy');
		expect(setBadge).toHaveBeenLastCalledWith(1);
		expect(readCalls()).toHaveLength(1);
	});

	test('reads nothing, and counts the conversation shown, while the window is not the one the person is in', async () => {
		renderProvider();
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('2');
		});

		document.hasFocus = () => false;
		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		expect(screen.getByTestId('count').textContent).toBe('2');
		expect(readCalls()).toHaveLength(0);

		document.hasFocus = () => true;
		act(() => {
			window.dispatchEvent(new Event('focus'));
		});
		expect(screen.getByTestId('count').textContent).toBe('1');
		await waitFor(() => {
			expect(readCalls()).toHaveLength(1);
		});
	});

	test('sends no read of an answer the api has read already', async () => {
		serve(() => [persona('general', false), persona('finance', true)]);
		renderProvider();
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('1');
		});

		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		await waitFor(() => {
			expect(fetchMock.mock.calls.filter(([url]) => url === LIST)).toHaveLength(1);
		});
		expect(readCalls()).toHaveLength(0);
	});

	test('keeps the count of the organization in the sidebar on the person’s account page', async () => {
		renderProvider(['harness'], '/account');

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('2');
		});
		expect(fetchMock).toHaveBeenCalledWith(LIST, expect.anything());
		expect(setBadge).toHaveBeenLastCalledWith(2);
	});

	test('tells of an answer that came once it has stayed unread a moment, and of none read meanwhile, as in another window', async () => {
		localStorage.setItem('proxy-notifications', 'on');
		let answers = {general: 'general-1', finance: 'finance-1'};
		let financeRead = false;
		serve(() => [
			{...persona('general', true), lastAnswer: {id: answers.general, text: 'Filed.'}},
			{...persona('finance', !financeRead), lastAnswer: {id: answers.finance, text: 'Paid.'}},
		]);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});

		// What was unread when the page opened is not told of.
		answers = {general: 'general-2', finance: 'finance-2'};
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(2);
		});
		expect(notifyDesktop).not.toHaveBeenCalled();

		// Finance's answer is read elsewhere meanwhile; General's stays unread and is told of.
		financeRead = true;
		comeBack();
		await waitFor(() => {
			expect(notifyDesktop).toHaveBeenCalledTimes(1);
		});
		expect(notifyDesktop).toHaveBeenCalledWith({
			title: 'general',
			body: 'Filed.',
			path: '/acme/chat/general',
			tag: 'general',
		});

		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(4);
		});
		expect(notifyDesktop).toHaveBeenCalledTimes(1);
	});

	test('takes the count off the badge when it goes, as when the person signs out', async () => {
		const {unmount} = renderProvider();
		await waitFor(() => {
			expect(setBadge).toHaveBeenLastCalledWith(2);
		});

		unmount();
		expect(setBadge).toHaveBeenLastCalledWith(0);
	});

	test('asks nothing without the harness experiment', async () => {
		renderProvider([]);

		await screen.findByTestId('count');
		expect(screen.getByTestId('count').textContent).toBe('0');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
