import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {ConnectionRow} from '@proxy/db/connection';
import type {ListedAlert, PersonaRow} from '@proxy/db/harness';
import type {PollRow} from '@proxy/db/poll';

import {type FakeStore, fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const now = new Date('2026-11-03T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona: PersonaRow = {id: 'persona-1', name: 'Finance', look, color: 'blue', createdById: 'user-1'};
const alert: ListedAlert = {
	id: 'alert-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	threadId: 'thread-1',
	title: 'Mail from the bank',
	brief: 'Mail from the bank about the loan.',
	at: null,
	collectionId: 'emails',
	connectionIds: ['conn-a', 'conn-gone'],
	criteria: '[{"field":"from","terms":["@bank.com"]}]',
	endedAt: null,
	endedBy: null,
	createdAt: now,
	persona,
	matches: [
		{
			id: 'match-1',
			alertId: 'alert-1',
			connectionId: 'conn-a',
			collectionId: 'emails',
			recordId: 'm1',
			title: 'Your loan',
			summary: 'from: dana@bank.com',
			url: 'https://mail.example/m1',
			createdAt: now,
		},
	],
	matchCount: 3,
};
const connection: ConnectionRow = {
	id: 'conn-a',
	orgId: 'org-1',
	integrationId: 'google',
	account: 'a@example.com',
	ownerUserId: null,
	connectedById: 'user-1',
	createdAt: now,
	tools: null,
	name: null,
	defaults: [],
};
const poll: PollRow = {
	id: 'poll-1',
	orgId: 'org-1',
	connectionId: 'conn-a',
	collectionId: 'emails',
	cursor: 'h1',
	nextAt: now,
	claimedBy: null,
	lastPolledAt: new Date('2026-11-03T09:50:00Z'),
	lastError: 'The mailbox could not be reached',
};

function request(params: Record<string, string> = {}) {
	return {user: {userId: 'user-1', email: 'a@example.com'}, params, body: undefined} as never;
}

let store: FakeStore;
let routes: ReturnType<typeof import('./alerts-route').alertRoutes>;

beforeEach(async () => {
	mock.clearAllMocks();
	store = fakeStore();
	routes = (await import('./alerts-route')).alertRoutes(store);
	requireViewer.mockResolvedValue(Ok(viewer));
	store.listMemberAlerts.mockResolvedValue(Ok([alert]));
	store.listConnectionsByIds.mockResolvedValue(Ok([connection]));
	store.listPolls.mockResolvedValue(Ok([poll]));
	store.deleteAlert.mockResolvedValue(Ok(true));
});

describe('the alerts routes', () => {
	test('are refused without the experiment', async () => {
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));
		expect((await routes.handleListAlertsRoute(request())).unwrapErr()).toMatchObject({kind: 'forbidden'});
		expect((await routes.handleDeleteAlertRoute(request({alertId: 'alert-1'}))).unwrapErr()).toMatchObject({kind: 'forbidden'});
		expect(store.deleteAlert).not.toHaveBeenCalled();
	});

	test('list the viewer’s alerts with the persona each was set with, the connections it watches by name, its looks and its matches, times as ISO', async () => {
		const {alerts} = (await routes.handleListAlertsRoute(request())).unwrap();
		expect(store.listMemberAlerts).toHaveBeenCalledWith('org-1', 'user-1');
		expect(store.listConnectionsByIds).toHaveBeenCalledWith('org-1', ['conn-a', 'conn-gone']);
		expect(alerts).toEqual([
			{
				id: 'alert-1',
				title: 'Mail from the bank',
				brief: 'Mail from the bank about the loan.',
				persona: {id: 'persona-1', name: 'Finance', look, color: 'blue'},
				at: null,
				collectionId: 'emails',
				criteria: [{field: 'from', terms: ['@bank.com']}],
				connections: [{id: 'conn-a', name: 'Google (a@example.com)'}],
				lastPolledAt: '2026-11-03T09:50:00.000Z',
				pollError: 'The mailbox could not be reached',
				matchCount: 3,
				matches: [{id: 'match-1', title: 'Your loan', summary: 'from: dana@bank.com', url: 'https://mail.example/m1', at: '2026-11-03T10:00:00.000Z'}],
				endedAt: null,
				endedBy: null,
				createdAt: '2026-11-03T10:00:00.000Z',
			},
		]);
	});

	test('delete one of the viewer’s alerts, and find none other', async () => {
		(await routes.handleDeleteAlertRoute(request({alertId: 'alert-1'}))).unwrap();
		expect(store.deleteAlert).toHaveBeenCalledWith('org-1', 'user-1', 'alert-1');
		store.deleteAlert.mockResolvedValue(Ok(false));
		expect((await routes.handleDeleteAlertRoute(request({alertId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found'});
	});
});
