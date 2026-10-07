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

const infoConnection = {id: 'info-1', integrationId: 'info', account: "Alex's Workspace", createdAt: new Date(), defaults: [{collectionId: 'addresses', access: 'read'}], credential: null};
const emailConnection = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: [{collectionId: 'emails', access: 'write'}], credential: 'v1.x.y.z'};

const agent = {id: 'agent-1', name: 'Shopping agent', grants: [{connectionId: 'info-1', collectionId: 'cards', access: 'read'}]};

const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock()};

const card = {id: 'rec-1', values: {label: 'Personal Visa', number: '4242'}, updatedAt: '2026-10-01T00:00:00.000Z'};

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined, query: Record<string, string> = {}) {
	return {agent: {agentId: 'agent-1', orgId: 'org-1', name: 'Shopping agent'}, params, body, query} as never;
}

function useTarget(connection: typeof infoConnection | typeof emailConnection, collectionId: string) {
	loadRecordTarget.mockResolvedValue(Ok({connection, collection: collection(connection.integrationId, collectionId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgent.mockResolvedValue(Ok(agent));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	listConnections.mockResolvedValue(Ok([infoConnection, emailConnection]));
	connector.list.mockResolvedValue(Ok({records: [card], nextPage: null}));
	connector.get.mockResolvedValue(Ok(card));
});

describe('handleAgentMeRoute', () => {
	test('lists what the agent can reach: its own settings, else the defaults, capped by the provider', async () => {
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
						{id: 'addresses', access: 'read'},
						{id: 'cards', access: 'read'},
					],
				},
				{id: 'mail-1', integrationId: 'email', account: 'alex@example.com', collections: [{id: 'emails', access: 'read'}]},
			],
		});
	});
});

describe('agent record routes', () => {
	test('a read the agent may make is logged with the record title', async () => {
		useTarget(infoConnection, 'cards');

		const {handleAgentGetRecordRoute} = await import('./route');
		const result = await handleAgentGetRecordRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards', recordId: 'rec-1'}));

		expect(result.unwrap()).toEqual({access: 'read', record: card});
		expect(logAgentRequest).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			connectionId: 'info-1',
			collectionId: 'cards',
			action: 'view',
			recordTitle: 'Personal Visa',
			query: null,
			outcome: 'allowed',
		});
	});

	test('a search is passed on and logged with what was searched for', async () => {
		useTarget(infoConnection, 'cards');

		const {handleAgentListRecordsRoute} = await import('./route');
		const result = await handleAgentListRecordsRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards'}, undefined, {search: ' visa ', page: 'rec-9'}));

		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: 'visa', page: 'rec-9'});
		expect(result.unwrap()).toEqual({access: 'read', records: [card], nextPage: null});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'list', query: 'visa', outcome: 'allowed'});
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

	test('a sent email can be sent with write access, never edited', async () => {
		useTarget({...emailConnection, defaults: [{collectionId: 'sent', access: 'write'}]}, 'sent');
		connector.create.mockResolvedValue(Ok({id: 'sent-1', values: {to: 'lena@example.com', subject: 'Thursday', body: ''}, updatedAt: '2026-10-01T00:00:00.000Z'}));

		const {handleAgentCreateRecordRoute, handleAgentUpdateRecordRoute} = await import('./route');
		const sent = await handleAgentCreateRecordRoute(makeRequest({connectionId: 'mail-1', collectionId: 'sent'}, {values: {to: 'lena@example.com', subject: 'Thursday'}}));
		const edited = await handleAgentUpdateRecordRoute(makeRequest({connectionId: 'mail-1', collectionId: 'sent', recordId: 'sent-1'}, {values: {to: 'max@example.com'}}));

		expect(sent.isOk()).toBe(true);
		expect(edited.unwrapErr().kind).toBe('forbidden');
		expect(connector.update).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[1]?.[0]).toMatchObject({collectionId: 'sent', action: 'update', outcome: 'denied'});
	});

	test('a default above what the provider allows is capped', async () => {
		useTarget(emailConnection, 'emails');

		const {handleAgentDeleteRecordRoute} = await import('./route');
		const result = await handleAgentDeleteRecordRoute(makeRequest({connectionId: 'mail-1', collectionId: 'emails', recordId: 'rec-1'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.remove).not.toHaveBeenCalled();
	});

	test('a read that cannot be logged is not returned', async () => {
		useTarget(infoConnection, 'cards');
		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleAgentListRecordsRoute} = await import('./route');
		const result = await handleAgentListRecordsRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards'}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});
