import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

const getAgent = mock();

mock.module('@proxy/db/agent', () => ({getAgent}));

const logAgentRequest = mock();

mock.module('@proxy/db/audit', () => ({logAgentRequest}));

const listConnections = mock();

mock.module('@proxy/db/connection', () => ({listConnections}));

const loadRecordTarget = mock();

mock.module('../records/target', () => ({loadRecordTarget}));

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

const infoConnection = {id: 'info-1', integrationId: 'info', account: "Alex's Workspace", createdAt: new Date(), defaults: [{collectionId: 'addresses', actionId: 'read'}], credential: null};
const emailConnection = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: [{collectionId: 'emails', actionId: 'read'}], credential: 'v1.x.y.z'};

const agent = {
	id: 'agent-1',
	name: 'Shopping agent',
	grants: [
		{connectionId: 'info-1', collectionId: 'cards', actionId: 'read', allowed: true},
		{connectionId: 'mail-1', collectionId: 'emails', actionId: 'read', allowed: false},
	],
};

const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock()};

const card = {id: 'rec-1', values: {label: 'Personal Visa', number: '4242'}, updatedAt: '2026-10-01T00:00:00.000Z'};

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {agent: {agentId: 'agent-1', orgId: 'org-1', name: 'Shopping agent'}, params, body} as never;
}

function useTarget(connection: typeof infoConnection | typeof emailConnection, collectionId: string) {
	loadRecordTarget.mockResolvedValue(Ok({connection, collection: collection(connection.integrationId, collectionId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgent.mockResolvedValue(Ok(agent));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	listConnections.mockResolvedValue(Ok([infoConnection, emailConnection]));
	connector.list.mockResolvedValue(Ok([card]));
	connector.get.mockResolvedValue(Ok(card));
});

describe('handleAgentMeRoute', () => {
	test('lists what the agent can do: its own settings, else the defaults, leaving out what it cannot read', async () => {
		const {handleAgentMeRoute} = await import('./route');
		const result = await handleAgentMeRoute(makeRequest());

		expect(result.unwrap()).toEqual({
			agent: {id: 'agent-1', name: 'Shopping agent'},
			connections: [
				{
					id: 'info-1',
					integrationId: 'info',
					account: "Alex's Workspace",
					collections: [
						{id: 'addresses', actions: ['read']},
						{id: 'cards', actions: ['read']},
					],
				},
			],
		});
	});
});

describe('agent record routes', () => {
	test('a read the agent may make is logged with the record title', async () => {
		useTarget(infoConnection, 'cards');

		const {handleAgentGetRecordRoute} = await import('./route');
		const result = await handleAgentGetRecordRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards', recordId: 'rec-1'}));

		expect(result.unwrap()).toEqual({actions: ['read'], record: card});
		expect(logAgentRequest).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			connectionId: 'info-1',
			collectionId: 'cards',
			action: 'view',
			recordTitle: 'Personal Visa',
			outcome: 'allowed',
		});
	});

	test('a collection without access is refused and logged as denied', async () => {
		useTarget(infoConnection, 'notes');

		const {handleAgentListRecordsRoute} = await import('./route');
		const result = await handleAgentListRecordsRoute(makeRequest({connectionId: 'info-1', collectionId: 'notes'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'notes', action: 'list', outcome: 'denied'});
	});

	test('writing with read access is refused', async () => {
		useTarget(infoConnection, 'cards');

		const {handleAgentCreateRecordRoute} = await import('./route');
		const result = await handleAgentCreateRecordRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards'}, {values: {label: 'New'}}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.create).not.toHaveBeenCalled();
	});

	test('what the collection does not offer is refused and logged', async () => {
		useTarget(emailConnection, 'emails');
		getAgent.mockResolvedValue(Ok({...agent, grants: []}));

		const {handleAgentUpdateRecordRoute} = await import('./route');
		const result = await handleAgentUpdateRecordRoute(makeRequest({connectionId: 'mail-1', collectionId: 'emails', recordId: 'rec-1'}, {values: {subject: 'Hi'}}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.update).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'emails', action: 'update', outcome: 'denied'});
	});

	test('a read that cannot be logged is not returned', async () => {
		useTarget(infoConnection, 'cards');
		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleAgentListRecordsRoute} = await import('./route');
		const result = await handleAgentListRecordsRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards'}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});
