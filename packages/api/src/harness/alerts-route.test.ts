import {expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {MemberAlertRow} from '@proxy/db/alerts';

import {fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', name: 'Northwind', role: 'member'};
mock.module('../utils/user-org', () => ({requireViewer: mock(async () => Ok(viewer))}));

const {alertRoutes} = await import('./alerts-route');

const now = new Date('2026-11-04T10:00:00Z');
const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
const slack = {teamId: 'T0001', channel: 'D0001', rootTs: '1761040800.000100'};

const alert: MemberAlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	chatId: 'chat-1',
	threadId: 'thread-1',
	setInThreadId: 'thread-1',
	title: 'Offsite deposit',
	brief: 'Remind them to pay it.',
	at: now,
	nextAt: now,
	every: null,
	timeZone: null,
	collectionId: null,
	connectionIds: [],
	terms: [],
	split: null,
	lastMatchedAt: null,
	slackAppId: null,
	slackChannel: null,
	createdAt: now,
	persona: {id: 'persona-1', name: 'Travel', look, color: 'teal', harness: 'proxy', chatModel: 'claude', ownerUserId: null, createdById: null, createdAt: now},
	thread: {id: 'thread-1', title: 'Plan the offsite in Lisbon', slack},
	setIn: {id: 'thread-1', title: 'Plan the offsite in Lisbon', slack},
};

test('an alert of a thread that lives in Slack links to that thread there; one of a thread in Chat has no link but its page', async () => {
	const store = fakeStore();
	store.listMemberAlerts.mockResolvedValue(Ok([alert, {...alert, id: 'alert-2', thread: null, threadId: null, setIn: {id: 'thread-2', title: 'Pricing review with Dana', slack: null}}]));
	store.listConnectionsByIds.mockResolvedValue(Ok([]));

	const {alerts} = (await alertRoutes(store).handleListAlertsRoute({params: {}, user: {userId: 'user-1'}} as never)).unwrap();

	const url = 'https://app.slack.com/client/T0001/D0001/thread/D0001-1761040800.000100';
	expect(alerts.map(({id, thread, setIn}) => [id, thread, setIn])).toEqual([
		['alert-1', {id: 'thread-1', title: 'Plan the offsite in Lisbon', slackUrl: url}, {id: 'thread-1', title: 'Plan the offsite in Lisbon', slackUrl: url}],
		['alert-2', null, {id: 'thread-2', title: 'Pricing review with Dana', slackUrl: null}],
	]);
});
