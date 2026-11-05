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
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(id: string, unread: boolean): ChatPersona {
	return {
		id,
		name: id,
		mayChange: false,
		look,
		color: 'blue',
		chatModel: null,
		unread,
		lastMessage: {id: `${id}-last`, kind: 'assistant', text: 'Done.', at: '2026-10-21T10:00:00Z'},
	};
}

// A page that shows what the provider has, and opens a conversation on request.
function Consumer() {
	const unread = useUnread();
	return (
		<div>
			<span data-testid="count">{unread.count}</span>
			<span data-testid="ids">{[...unread.unreadIds].join(',')}</span>
			<button type="button" onClick={() => unread.setOpen('general')}>
				Open General
			</button>
			<button type="button" onClick={() => unread.markSeen('finance')}>
				Seen Finance
			</button>
		</div>
	);
}

function renderProvider(experiments: Experiment[] = ['harness']) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, experiments}),
				element: <HumanSide />,
				children: [{path: '/:org', element: <Consumer />}],
			},
		],
		{initialEntries: ['/acme']},
	);
	return render(<RouterProvider router={router} />);
}

const setBadge = mock((_count: number) => undefined);

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(() =>
		Promise.resolve(
			Response.json({personas: [persona('general', true), persona('finance', true)]}),
		),
	);
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
	setBadge.mockClear();
	window.personalAgentProxyDesktop = {
		updateReady: () => Promise.resolve(null),
		onUpdateReady: () => () => undefined,
		restart: () => undefined,
		notify: () => undefined,
		onOpenPath: () => () => undefined,
		setBadge,
	};
	document.title = 'Personal Agent Proxy';
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
	delete window.personalAgentProxyDesktop;
});

describe('UnreadProvider', () => {
	test('asks for the conversations, counts those with something unread, in the title and on the badge, less the one open, and one seen', async () => {
		renderProvider();

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('2');
		});
		expect(fetchMock).toHaveBeenCalledWith('/api/orgs/acme/chat/personas', expect.anything());
		expect(screen.getByTestId('ids').textContent).toBe('general,finance');
		expect(document.title).toBe('(2) Personal Agent Proxy');
		expect(setBadge).toHaveBeenLastCalledWith(2);

		act(() => {
			screen.getByRole('button', {name: 'Open General'}).click();
		});
		expect(screen.getByTestId('count').textContent).toBe('1');
		expect(screen.getByTestId('ids').textContent).toBe('finance');

		act(() => {
			screen.getByRole('button', {name: 'Seen Finance'}).click();
		});
		expect(screen.getByTestId('count').textContent).toBe('0');
		expect(document.title).toBe('Personal Agent Proxy');
		expect(setBadge).toHaveBeenLastCalledWith(0);
	});

	test('asks nothing without the harness experiment', async () => {
		renderProvider([]);

		await screen.findByTestId('count');
		expect(screen.getByTestId('count').textContent).toBe('0');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
