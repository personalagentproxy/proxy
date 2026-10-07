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

const infoConnection = {id: 'info-1', integrationId: 'info', account: "Alex's Workspace", createdAt: new Date(), defaults: [{actionId: 'readAddresses'}], credential: null};
const emailConnection = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: [{actionId: 'read'}], credential: 'v1.x.y.z'};

const agent = {
	id: 'agent-1',
	name: 'Shopping agent',
	grants: [
		{connectionId: 'info-1', actionId: 'readCards', allowed: true},
		{connectionId: 'mail-1', actionId: 'read', allowed: false},
	],
};

// Reads the mailbox by default, archives and sends of its own.
const triage = {
	...agent,
	grants: [
		{connectionId: 'mail-1', actionId: 'archive', allowed: true},
		{connectionId: 'mail-1', actionId: 'send', allowed: true},
	],
};

const inboxEmail = {id: 'inbox-7-12', values: {folder: 'Inbox', subject: 'Invoice #20931'}, updatedAt: '2026-10-01T00:00:00.000Z'};
const draft = {id: 'drafts-7-3', values: {folder: 'Draft', subject: 'Re: Q3 planning'}, updatedAt: '2026-10-01T00:00:00.000Z'};

const archive = mock();
const send = mock();
const sendNew = mock();

const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock(), commands: {archive, send}, newCommands: {sendNew}};

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
	test('lists what the agent can do with each connection, leaving out those it can do nothing with', async () => {
		const {handleAgentMeRoute} = await import('./route');
		const result = await handleAgentMeRoute(makeRequest());

		expect(result.unwrap()).toEqual({
			agent: {id: 'agent-1', name: 'Shopping agent'},
			connections: [{id: 'info-1', integrationId: 'info', account: "Alex's Workspace", actions: ['readAddresses', 'readCards']}],
		});
	});
});

describe('agent record routes', () => {
	test('a read the agent may make is logged with the record title', async () => {
		useTarget(infoConnection, 'cards');

		const {handleAgentGetRecordRoute} = await import('./route');
		const result = await handleAgentGetRecordRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards', recordId: 'rec-1'}));

		expect(result.unwrap()).toEqual({actions: ['readAddresses', 'readCards'], record: card});
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

	test('only drafts can be edited, even with Write drafts', async () => {
		useTarget(emailConnection, 'emails');
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'write', allowed: true}]}));
		connector.get.mockResolvedValue(Ok(inboxEmail));

		const {handleAgentUpdateRecordRoute} = await import('./route');
		const result = await handleAgentUpdateRecordRoute(makeRequest({connectionId: 'mail-1', collectionId: 'emails', recordId: inboxEmail.id}, {values: {subject: 'Hi'}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});

	test('a read that cannot be logged is not returned', async () => {
		useTarget(infoConnection, 'cards');
		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleAgentListRecordsRoute} = await import('./route');
		const result = await handleAgentListRecordsRoute(makeRequest({connectionId: 'info-1', collectionId: 'cards'}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});

describe('handleAgentRunCommandRoute', () => {
	const params = {connectionId: 'mail-1', collectionId: 'emails', recordId: inboxEmail.id};

	beforeEach(() => {
		useTarget(emailConnection, 'emails');
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));
		archive.mockResolvedValue(Ok(null));
		send.mockResolvedValue(Ok(null));
	});

	test('runs a command the agent has the action for, and logs it with the record title', async () => {
		const {handleAgentRunCommandRoute} = await import('./route');
		const result = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'archive'}));

		expect(result.unwrap()).toEqual({record: null});
		expect(archive).toHaveBeenCalledTimes(1);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'archive', recordTitle: 'Invoice #20931', outcome: 'allowed'});
	});

	test('a command without its action is refused and logged as denied', async () => {
		getAgent.mockResolvedValue(Ok({...triage, grants: []}));

		const {handleAgentRunCommandRoute} = await import('./route');
		const result = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'archive'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(archive).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'archive', outcome: 'denied'});
	});

	test('a command on a record it does not apply to is refused, not run', async () => {
		const {handleAgentRunCommandRoute} = await import('./route');
		const sendInboxEmail = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'send'}));
		connector.get.mockResolvedValue(Ok(draft));
		const archiveDraft = await handleAgentRunCommandRoute(makeRequest({...params, recordId: draft.id, commandId: 'archive'}));

		expect(sendInboxEmail.unwrapErr().kind).toBe('validation_error');
		expect(archiveDraft.unwrapErr().kind).toBe('validation_error');
		expect(send).not.toHaveBeenCalled();
		expect(archive).not.toHaveBeenCalled();
	});

	test('a command the collection does not have is not found and not logged', async () => {
		const {handleAgentRunCommandRoute} = await import('./route');
		const nonsense = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'nonsense'}));
		const newOnly = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'sendNew'}));

		expect(nonsense.unwrapErr().kind).toBe('not_found');
		expect(newOnly.unwrapErr().kind).toBe('not_found');
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('a failed command is not logged as allowed', async () => {
		archive.mockResolvedValue(Err(ApiErr.notFound('folder', 'Archive')));

		const {handleAgentRunCommandRoute} = await import('./route');
		const result = await handleAgentRunCommandRoute(makeRequest({...params, commandId: 'archive'}));

		expect(result.unwrapErr().kind).toBe('not_found');
		expect(logAgentRequest).not.toHaveBeenCalled();
	});
});

describe('handleAgentRunNewCommandRoute', () => {
	const params = {connectionId: 'mail-1', collectionId: 'emails', commandId: 'sendNew'};
	const body = {values: {to: 'sam@example.com', subject: 'Friday', body: 'See you then.'}};

	beforeEach(() => {
		useTarget(emailConnection, 'emails');
		sendNew.mockResolvedValue(Ok(null));
	});

	test('sends a new email with Send alone, and logs its subject', async () => {
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));

		const {handleAgentRunNewCommandRoute} = await import('./route');
		const result = await handleAgentRunNewCommandRoute(makeRequest(params, body));

		expect(result.unwrap()).toEqual({record: null});
		expect(sendNew.mock.calls[0]?.[1]).toEqual(body.values);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'sendNew', recordTitle: 'Friday', outcome: 'allowed'});
	});

	test('is refused without Send', async () => {
		const {handleAgentRunNewCommandRoute} = await import('./route');
		const result = await handleAgentRunNewCommandRoute(makeRequest(params, body));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(sendNew).not.toHaveBeenCalled();
	});
});
