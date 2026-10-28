/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import type {ChatPersona} from '@/client/harness-client';
import type {
	InspectedEntry,
	InspectedJob,
	InspectedThread,
	Inspection,
	ModelRequest,
} from '@/client/inspect-client';
import {InspectPage} from '@/pages/inspect-page';
import {testHuman} from '@/test-org';

const now = '2026-10-21T10:00:00.000Z';
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona: ChatPersona = {
	id: 'persona-1',
	name: 'Finance',
	look,
	color: 'blue',
	mayChange: true,
	lastMessage: null,
};

function entry(
	seq: number,
	kind: InspectedEntry['kind'],
	text: string,
	extra: Partial<InspectedEntry> = {},
): InspectedEntry {
	return {
		id: `e${seq}`,
		seq,
		kind,
		text,
		toolCalls: null,
		callId: null,
		isError: false,
		pending: false,
		inputTokens: null,
		outputTokens: null,
		coversSeq: null,
		hasSystem: false,
		jobId: null,
		at: now,
		...extra,
	};
}

function job(id: string, threadId: string, extra: Partial<InspectedJob> = {}): InspectedJob {
	return {
		id,
		threadId,
		kind: 'inference',
		status: 'done',
		entryId: null,
		callId: null,
		runAt: now,
		claimedBy: null,
		leaseExpiresAt: null,
		attempts: 1,
		error: null,
		createdAt: now,
		...extra,
	};
}

const state = {
	ready: false,
	pendingCalls: [],
	turnsAlone: 1,
	maxTurnsAlone: 30,
	lastInputTokens: 1200,
	compactAtTokens: 80_000,
	compactionCoversSeq: null,
};

// The person asked for invoices, the agent delegated, and the sub-agent is reading.
const conversation: InspectedThread = {
	id: 'thread-1',
	parentThreadId: null,
	parentCallId: null,
	title: null,
	taskId: null,
	finishedAt: null,
	createdAt: now,
	entries: [
		entry(1, 'person', 'Find my invoices'),
		entry(2, 'assistant', '', {
			toolCalls: [
				{
					id: 'c1',
					name: 'delegate',
					arguments: '{"title":"Find the invoices","brief":"Find them"}',
				},
			],
			inputTokens: 1200,
			outputTokens: 40,
			hasSystem: true,
			jobId: 'job-1',
		}),
		entry(3, 'tool_result', 'Started the sub-agent “Find the invoices”.', {
			callId: 'c1',
			jobId: 'job-2',
		}),
		entry(9, 'person', 'Thanks', {pending: true}),
	],
	jobs: [
		job('job-1', 'thread-1'),
		job('job-2', 'thread-1', {kind: 'tool', entryId: 'e2', callId: 'c1'}),
	],
	events: [
		{
			id: 'ev1',
			jobId: 'job-1',
			threadId: 'thread-1',
			kind: 'claimed',
			workerId: 'host-1',
			error: null,
			at: '2026-10-21T09:59:58.000Z',
		},
		{
			id: 'ev2',
			jobId: 'job-1',
			threadId: 'thread-1',
			kind: 'done',
			workerId: 'host-1',
			error: null,
			at: '2026-10-21T10:00:00.500Z',
		},
	],
	state,
};
const subAgent: InspectedThread = {
	id: 'thread-2',
	parentThreadId: 'thread-1',
	parentCallId: 'c1',
	title: 'Find the invoices',
	taskId: 'task-2',
	finishedAt: null,
	createdAt: now,
	entries: [
		entry(4, 'person', 'Find them'),
		entry(5, 'assistant', '', {
			toolCalls: [
				{id: 'c2', name: 'read', arguments: '{"connection":"gmail-1","tool":"list_emails"}'},
			],
			inputTokens: 800,
			outputTokens: 30,
			hasSystem: true,
			jobId: 'job-3',
		}),
	],
	jobs: [
		job('job-3', 'thread-2'),
		job('job-4', 'thread-2', {
			kind: 'tool',
			status: 'running',
			entryId: 'e5',
			callId: 'c2',
			claimedBy: 'host-1',
			leaseExpiresAt: '2026-10-21T10:02:00.000Z',
		}),
	],
	events: [
		{
			id: 'ev4',
			jobId: 'job-3',
			threadId: 'thread-2',
			kind: 'claimed',
			workerId: 'host-1',
			error: null,
			at: '2026-10-21T09:59:50.000Z',
		},
		{
			id: 'ev5',
			jobId: 'job-3',
			threadId: 'thread-2',
			kind: 'done',
			workerId: 'host-1',
			error: null,
			at: '2026-10-21T09:59:53.000Z',
		},
		{
			id: 'ev3',
			jobId: 'job-4',
			threadId: 'thread-2',
			kind: 'claimed',
			workerId: 'host-1',
			error: null,
			at: '2026-10-21T09:59:59.000Z',
		},
	],
	state: {
		...state,
		pendingCalls: [{id: 'c2', name: 'read', arguments: '{}'}],
		lastInputTokens: 800,
	},
};

const inspection: Inspection = {persona, now, threads: [conversation, subAgent]};

const request: ModelRequest = {
	kind: 'turn',
	system: 'You are signed in.',
	messages: [
		{role: 'system', content: 'You are signed in.'},
		{role: 'user', content: 'Find my invoices'},
	],
	tools: [{name: 'delegate', description: 'Delegates', parameters: {type: 'object'}}],
};

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation((input) => {
		if (input.endsWith('/request')) {
			return Promise.resolve(Response.json(request));
		}
		if (input.endsWith('/inspect')) {
			return Promise.resolve(Response.json(inspection));
		}
		return Promise.resolve(Response.json({error: 'unexpected'}, {status: 500}));
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
});

function renderInspectPage() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/inspect/:id',
						loader: () => ({inspection, personas: [persona]}),
						element: <InspectPage />,
					},
				],
			},
		],
		{initialEntries: ['/acme/inspect/persona-1']},
	);
	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('InspectPage', () => {
	test('lists the conversation and its sub-agents with where each stands, and the jobs open on them', async () => {
		renderInspectPage();
		const threads = await screen.findByRole('region', {name: 'Threads'});
		const rows = within(threads).getAllByRole('button');
		expect(rows[0]?.textContent).toContain('Conversation');
		expect(rows[0]?.textContent).toContain('waiting');
		expect(rows[1]?.textContent).toContain('Find the invoices');
		expect(rows[1]?.textContent).toContain('working');
		expect(rows[1]?.textContent).toContain('1 open calls');
		expect(
			within(threads).getByRole('link', {name: 'Task in the activity log'}).getAttribute('href'),
		).toBe('/acme/activity/tasks/task-2');

		const jobs = screen.getByRole('region', {name: 'Jobs'});
		expect(jobs.textContent).toContain('running');
		expect(jobs.textContent).toContain('read');
		expect(jobs.textContent).toContain('host-1');
		expect(jobs.textContent).not.toContain('inference');
		fireEvent.click(within(jobs).getByRole('button', {name: 'With history'}));
		expect(jobs.textContent).toContain('inference');
		expect(jobs.textContent).toContain('ran 2.5s');
	});

	test('shows the conversation’s whole log, the calls with their arguments and what is pending', async () => {
		renderInspectPage();
		const log = await screen.findByRole('list', {name: 'Log'});
		// The log's own items, not the calls listed within one.
		const items = within(log)
			.getAllByRole('listitem')
			.filter((item) => item.parentElement === log);
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining('#1person'),
			expect.stringContaining('delegate'),
			expect.stringContaining('answers c1'),
			expect.stringContaining('pending'),
		]);
		expect(items[1]?.textContent).toContain('"title": "Find the invoices"');
		expect(items[1]?.textContent).toContain('1,200 in / 40 out');
		expect(screen.getByText(/nothing new for the model/)).toBeDefined();
		expect(screen.getByText('1 pending')).toBeDefined();
	});

	test('opens a sub-agent’s log, and the request behind an answer in it', async () => {
		renderInspectPage();
		const threads = await screen.findByRole('region', {name: 'Threads'});
		fireEvent.click(within(threads).getByRole('button', {name: /Find the invoices/}));
		expect(screen.getByText(/waiting on read/)).toBeDefined();
		const log = screen.getByRole('list', {name: 'Log'});
		expect(log.textContent).toContain('list_emails');

		fireEvent.click(within(log).getByRole('button', {name: 'Request'}));
		await waitFor(() => {
			expect(screen.getByText(/A turn: 2 messages, 1 tools/)).toBeDefined();
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/orgs/acme/chat/inspect/entries/e5/request');
		expect(screen.getByText('Find my invoices', {selector: 'pre'})).toBeDefined();
		expect(screen.getByText('delegate', {selector: 'summary'})).toBeDefined();
		expect(screen.getByText('claimed')).toBeDefined();
		expect(screen.getByText('after 3.0s')).toBeDefined();
	});
});
