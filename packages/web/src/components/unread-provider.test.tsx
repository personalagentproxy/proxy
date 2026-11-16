/// <reference types="bun" />

import type {ChatAnswer} from '@proxy/contracts/harness';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {useUnread} from '@/hooks/use-unread';
import {testHuman, testOrg} from '@/test-org';

const realFetch = globalThis.fetch;
const realHasFocus = document.hasFocus.bind(document);
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();

const LIST = '/api/orgs/acme/chat/answers';
const READ_GENERAL = '/api/orgs/acme/chat/personas/general/read';

// A chat whose last answer is the one given, or its own, which its one thread's turn ended with,
// unread or read.
function persona(
	id: string,
	unread: boolean,
	answer = {id: `${id}-answer`, text: 'Done.'},
): ChatAnswer {
	return {
		personaId: id,
		name: id,
		answer,
		unread: unread ? [{threadId: `${id}-thread`, answer, ended: true}] : [],
	};
}

// The api: the last answers as `listed` has them, and a read that lands, or fails where `read`
// says so, with its status, or 503; `read` is called with what it was sent.
function serve(
	listed: () => ChatAnswer[],
	read: (body: string) => boolean | number | void = () => true,
) {
	fetchMock.mockImplementation((input, init) => {
		if (input.endsWith('/read')) {
			const landed = read(String(init?.body));
			const status = typeof landed === 'number' ? landed : landed === false ? 503 : 204;
			return Promise.resolve(new Response(null, {status}));
		}
		return Promise.resolve(Response.json({answers: listed()}));
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
			<span data-testid="count">{unread.count}</span>
			<span data-testid="ids">{[...unread.unreadIds].join(',')}</span>
			<span data-testid="answers">
				{(unread.answers ?? []).map(({answer}) => answer.id).join(',')}
			</span>
			<button
				type="button"
				onClick={() =>
					unread.setViewing({
						personaId: 'general',
						threadId: 'general-thread',
						answerId: 'general-answer',
					})
				}
			>
				View General
			</button>
			<button type="button" onClick={() => unread.setViewing(null)}>
				Leave
			</button>
		</div>
	);
}

function renderProvider(entry = '/acme') {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(testOrg),
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
	test('asks for the conversations, counts their threads ended unread, in the title and on the badge, the one looked at too, and reads the thread open in it up to the answer shown', async () => {
		let generalRead = false;
		const bodies: string[] = [];
		const paid = {threadId: 'finance-2', answer: {id: 'paid', text: 'Paid.'}, ended: true};
		const looking = {
			threadId: 'finance-3',
			answer: {id: 'looking', text: 'Looking.'},
			ended: false,
		};
		serve(
			() => [
				persona('general', !generalRead),
				{...persona('finance', true), unread: [...persona('finance', true).unread, paid, looking]},
			],
			(body) => {
				bodies.push(body);
				generalRead = true;
			},
		);
		renderProvider();

		// General's one thread and Finance's two that ended; not Finance's at work.
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('3');
		});
		expect(fetchMock).toHaveBeenCalledWith(LIST, expect.anything());
		expect(screen.getByTestId('ids').textContent).toBe('general,finance');
		expect(document.title).toBe('(3) Personal Agent Proxy');
		expect(setBadge).toHaveBeenLastCalledWith(3);

		// Looked at, General is counted still, until its thread is read.
		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		expect(screen.getByTestId('count').textContent).toBe('3');
		await waitFor(() => {
			expect(bodies).toEqual([JSON.stringify({entryId: 'general-answer'})]);
		});

		// Once the read lands the conversations are asked about again.
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('2');
		});
		expect(screen.getByTestId('ids').textContent).toBe('finance');
		expect(document.title).toBe('(2) Personal Agent Proxy');
		// The badge goes from one count to the next, never to none between.
		expect(setBadge.mock.calls.map(([count]) => count)).toEqual([0, 3, 2]);
		expect(readCalls()).toHaveLength(1);
	});

	test('reads nothing while the window is not the one the person is in', async () => {
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
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readCalls()).toHaveLength(0);

		document.hasFocus = () => true;
		act(() => {
			window.dispatchEvent(new Event('focus'));
		});
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

	test('sends no read before it has asked whether the api has it read already', async () => {
		let answer: () => void = () => undefined;
		const listed = new Promise<void>((resolve) => {
			answer = resolve;
		});
		fetchMock.mockImplementation(async (input) => {
			if (input.endsWith('/read')) {
				return new Response(null, {status: 204});
			}
			await listed;
			return Response.json({answers: [persona('general', false)]});
		});
		renderProvider();
		const view = await screen.findByRole('button', {name: 'View General'});
		act(() => {
			view.click();
		});
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});
		expect(readCalls()).toHaveLength(0);

		answer();
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0');
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(readCalls()).toHaveLength(0);
	});

	test('sends a read that failed again once the next poll lands', async () => {
		let failing = true;
		serve(
			() => [persona('general', true)],
			() => !failing,
		);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});
		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		await waitFor(() => {
			expect(readCalls()).toHaveLength(1);
		});

		failing = false;
		comeBack();
		await waitFor(() => {
			expect(readCalls()).toHaveLength(2);
		});
	});

	test('sends no read the api refused again, as of an answer gone', async () => {
		serve(
			() => [persona('general', true)],
			() => 404,
		);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});
		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});
		await waitFor(() => {
			expect(readCalls()).toHaveLength(1);
		});

		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(2);
		});
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(3);
		});
		expect(readCalls()).toHaveLength(1);
	});

	test('keeps the count of the organization in the sidebar on the person’s account page', async () => {
		renderProvider('/account');

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
			persona('general', true, {id: answers.general, text: 'Filed.'}),
			persona('finance', !financeRead, {id: answers.finance, text: 'Paid.'}),
		]);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});

		// What was unread when the page opened is not told of. The poll has landed before the clock
		// moves on, so its wait for the new answers is timed from when it did.
		answers = {general: 'general-2', finance: 'finance-2'};
		comeBack();
		await waitFor(() => {
			expect(screen.getByTestId('answers').textContent).toBe('general-2,finance-2');
		});
		expect(listCalls()).toHaveLength(2);
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
			tag: 'general-thread',
		});

		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(4);
		});
		expect(notifyDesktop).toHaveBeenCalledTimes(1);
	});

	test('tells of each thread once its turn ends, by what it said last, however much newer another thread at work says', async () => {
		localStorage.setItem('proxy-notifications', 'on');
		// The chat's last answer, and its threads unread.
		let latest = {id: 'b-0', text: 'Earlier.'};
		let unread: ChatAnswer['unread'] = [];
		serve(() => [{...persona('general', false, latest), unread}]);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});

		// One thread ends its turn as the other, at work, says something newer.
		const paid = {threadId: 'thread-a', answer: {id: 'a-1', text: 'Both are paid.'}, ended: true};
		latest = {id: 'b-1', text: 'Looking.'};
		unread = [paid, {threadId: 'thread-b', answer: latest, ended: false}];
		comeBack();
		await waitFor(() => {
			expect(screen.getByTestId('answers').textContent).toBe('b-1');
		});
		expect(notifyDesktop).not.toHaveBeenCalled();

		// It is told of once it has stayed unread a moment, while the other says more.
		latest = {id: 'b-2', text: 'Checking the second.'};
		unread = [paid, {threadId: 'thread-b', answer: latest, ended: false}];
		comeBack();
		await waitFor(() => {
			expect(notifyDesktop).toHaveBeenCalledTimes(1);
		});
		expect(notifyDesktop).toHaveBeenCalledWith({
			title: 'general',
			body: 'Both are paid.',
			path: '/acme/chat/general',
			tag: 'thread-a',
		});

		// The other ends its turn: what it said last is told of, apart, and nothing it said before.
		latest = {id: 'b-3', text: 'Filed the receipt.'};
		unread = [paid, {threadId: 'thread-b', answer: latest, ended: true}];
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(4);
		});
		comeBack();
		await waitFor(() => {
			expect(notifyDesktop).toHaveBeenCalledTimes(2);
		});
		expect(notifyDesktop).toHaveBeenLastCalledWith({
			title: 'general',
			body: 'Filed the receipt.',
			path: '/acme/chat/general',
			tag: 'thread-b',
		});
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(6);
		});
		expect(notifyDesktop).toHaveBeenCalledTimes(2);
	});

	test('tells of no thread that ends while the person looks at its conversation, where they see it end, not once they look away', async () => {
		localStorage.setItem('proxy-notifications', 'on');
		let unread: ChatAnswer['unread'] = [];
		serve(() => [{...persona('general', false), unread}]);
		renderProvider();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(1);
		});
		act(() => {
			screen.getByRole('button', {name: 'View General'}).click();
		});

		// Another thread than the one open ends while the person looks: it stays unread, untold.
		unread = [{threadId: 'thread-a', answer: {id: 'a-1', text: 'Filed.'}, ended: true}];
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(2);
		});
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(3);
		});

		act(() => {
			screen.getByRole('button', {name: 'Leave'}).click();
		});
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(4);
		});
		comeBack();
		await waitFor(() => {
			expect(listCalls()).toHaveLength(5);
		});
		expect(notifyDesktop).not.toHaveBeenCalled();
		expect(screen.getByTestId('ids').textContent).toBe('general');
	});

	test('takes the count off the badge when it goes, as when the person signs out', async () => {
		const {unmount} = renderProvider();
		await waitFor(() => {
			expect(setBadge).toHaveBeenLastCalledWith(2);
		});

		unmount();
		expect(setBadge).toHaveBeenLastCalledWith(0);
	});
});
