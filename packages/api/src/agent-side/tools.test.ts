import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {findIntegration, type Integration} from '@proxy/integrations';

const getAgent = mock();

mock.module('@proxy/db/agent', () => ({getAgent}));

const logAgentRequest = mock();

mock.module('@proxy/db/audit', () => ({logAgentRequest}));

const listConnections = mock();

mock.module('@proxy/db/connection', () => ({listConnections}));

const loadConnection = mock();

mock.module('../records/target', () => ({loadConnection}));

function integration(id: string): Integration {
	const found = findIntegration(id);
	if (!found) {
		throw new Error(`No integration ${id}`);
	}
	return found;
}

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'dot', name: 'Dot'};
const caller = {agent: signedIn, via: 'mcp' as const};

const infoConnection = {id: 'info-1', integrationId: 'info', account: "Alex's Workspace", createdAt: new Date(), defaults: [{actionId: 'readAddresses'}], credential: null};
const emailConnection = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: [{actionId: 'read'}], credential: 'v1.x.y.z'};

// Reads cards of its own, and doesn't read the mailbox.
const agent = {
	id: 'agent-1',
	providerId: 'dot',
	name: 'Dot',
	grants: [
		{connectionId: 'info-1', actionId: 'readCards', allowed: true},
		{connectionId: 'mail-1', actionId: 'read', allowed: false},
	],
};

// Reads the mailbox by default, writes drafts, archives and sends of its own.
const triage = {
	...agent,
	grants: ['write', 'archive', 'send'].map((actionId) => ({connectionId: 'mail-1', actionId, allowed: true})),
};

const card = {id: 'rec-1', values: {label: 'Personal Visa', number: '4242'}, updatedAt: '2026-10-01T00:00:00.000Z'};
const inboxEmail = {id: 'inbox-7-12', values: {folder: 'Inbox', subject: 'Invoice #20931'}, updatedAt: '2026-10-01T00:00:00.000Z'};
const draft = {id: 'drafts-7-3', values: {folder: 'Draft', from: 'alex@example.com', to: 'sam@example.com', subject: 'Re: Q3 planning', body: 'Draft body'}, updatedAt: '2026-10-01T00:00:00.000Z'};

const archive = mock();
const send = mock();
const sendNew = mock();
const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock(), commands: {archive, send}, newCommands: {sendNew}};

function useConnection(connection: typeof infoConnection | typeof emailConnection) {
	loadConnection.mockResolvedValue(Ok({connection, integration: integration(connection.integrationId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgent.mockResolvedValue(Ok(agent));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	listConnections.mockResolvedValue(Ok([infoConnection, emailConnection]));
	connector.list.mockResolvedValue(Ok({records: [card], nextPage: null}));
	connector.get.mockResolvedValue(Ok(card));
	useConnection(infoConnection);
});

describe('listAgentConnections', () => {
	test('lists what the agent can do with each connection, leaving out those it can do nothing with', async () => {
		const {listAgentConnections} = await import('./tools');
		const result = await listAgentConnections(signedIn);

		expect(result.unwrap()).toEqual({
			agent: {id: 'agent-1', providerId: 'dot', name: 'Dot'},
			connections: [{id: 'info-1', integrationId: 'info', account: "Alex's Workspace", actions: ['readAddresses', 'readCards']}],
		});
	});
});

describe('listAgentTools', () => {
	test("the tools of the connection's actions the agent has", async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));

		const {listAgentTools} = await import('./tools');
		const result = await listAgentTools(signedIn, 'mail-1');

		expect(result.unwrap().map((tool) => tool.name)).toEqual(['emails_list', 'emails_get', 'emails_send', 'emails_send_new']);
	});
});

describe('runAgentTool', () => {
	test('a read the agent may make is logged with the record title', async () => {
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'info-1', 'cards_get', {id: 'rec-1'});

		expect(result.unwrap()).toEqual({record: card});
		expect(connector.get.mock.calls[0]?.[1]).toBe('rec-1');
		expect(logAgentRequest).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			connectionId: 'info-1',
			collectionId: 'cards',
			action: 'view',
			recordTitle: 'Personal Visa',
			query: null,
			outcome: 'allowed',
			via: 'mcp',
		});
	});

	test('a tool without its action is refused and logged as denied, its search too', async () => {
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'info-1', 'notes_list', {search: ' sizes '});

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'notes', action: 'list', query: 'sizes', outcome: 'denied'});
	});

	test('a list passes the search, the filter field and the page on', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'mail-1', 'emails_list', {search: 'invoice', folder: 'Inbox', page: 'next'});

		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: 'invoice', page: 'next', filter: 'Inbox'});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'list', query: 'invoice', outcome: 'allowed'});
	});

	test('params the tool does not take are refused before anything runs', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		const unknown = await runAgentTool(caller, 'mail-1', 'emails_list', {filter: 'Inbox'});
		const outsideEnum = await runAgentTool(caller, 'mail-1', 'emails_list', {folder: 'Spam'});
		const missingId = await runAgentTool(caller, 'mail-1', 'emails_get', {});
		const notText = await runAgentTool(caller, 'mail-1', 'emails_get', {id: 7});

		for (const result of [unknown, outsideEnum, missingId, notText]) {
			expect(result.unwrapErr().kind).toBe('validation_error');
		}
		expect(connector.list).not.toHaveBeenCalled();
		expect(connector.get).not.toHaveBeenCalled();
	});

	test('limited to tools that read, or to those that change something, any other is refused unlogged', async () => {
		const {runAgentTool} = await import('./tools');
		const readingAWrite = await runAgentTool(caller, 'info-1', 'cards_create', {label: 'New'}, {readOnly: true});
		const runningARead = await runAgentTool(caller, 'info-1', 'cards_list', {}, {readOnly: false});

		expect(readingAWrite.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'cards_create changes something: use run for it'});
		expect(runningARead.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'cards_list only reads: use read for it'});
		expect(connector.create).not.toHaveBeenCalled();
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('a connection outside the organization or a tool the integration lacks is not found and not logged', async () => {
		const {runAgentTool} = await import('./tools');
		const tool = await runAgentTool(caller, 'info-1', 'cards_send', {});
		loadConnection.mockResolvedValue(Err(ApiErr.notFound('connection', 'elsewhere')));
		const connection = await runAgentTool(caller, 'elsewhere', 'cards_list', {});

		expect(tool.unwrapErr().kind).toBe('not_found');
		expect(connection.unwrapErr().kind).toBe('not_found');
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('an edit changes only the fields given', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(draft));
		connector.update.mockResolvedValue(Ok({...draft, values: {...draft.values, subject: 'Re: Q4 planning'}}));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: draft.id, subject: 'Re: Q4 planning'});

		expect(result.isOk()).toBe(true);
		expect(connector.update.mock.calls[0]?.slice(1)).toEqual([draft.id, {to: 'sam@example.com', subject: 'Re: Q4 planning', body: 'Draft body'}]);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'update', recordTitle: 'Re: Q4 planning'});
	});

	test('an edit refuses the fields the provider sets', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(draft));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: draft.id, folder: 'Inbox'});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});

	test('only drafts can be edited, even with Write drafts', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: inboxEmail.id, subject: 'Hi'});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});

	test('runs a command on a record, logged with its title, and only where it applies', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));
		archive.mockResolvedValue(Ok(null));

		const {runAgentTool} = await import('./tools');
		const archived = await runAgentTool(caller, 'mail-1', 'emails_archive', {id: inboxEmail.id});
		const sendInbox = await runAgentTool(caller, 'mail-1', 'emails_send', {id: inboxEmail.id});

		expect(archived.unwrap()).toEqual({record: null});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'archive', recordTitle: 'Invoice #20931', outcome: 'allowed'});
		expect(sendInbox.unwrapErr().kind).toBe('validation_error');
		expect(send).not.toHaveBeenCalled();
	});

	test('sends a new email with Send alone, and logs its subject', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));
		sendNew.mockResolvedValue(Ok(null));
		const values = {to: 'sam@example.com', subject: 'Friday', body: 'See you then.'};

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_send_new', values);

		expect(result.unwrap()).toEqual({record: null});
		expect(sendNew.mock.calls[0]?.[1]).toEqual(values);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'sendNew', recordTitle: 'Friday', outcome: 'allowed'});
	});

	test('a failed run is not logged as allowed, and a run that cannot be logged is not returned', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));
		archive.mockResolvedValue(Err(ApiErr.notFound('folder', 'Archive')));

		const {runAgentTool} = await import('./tools');
		const failed = await runAgentTool(caller, 'mail-1', 'emails_archive', {id: inboxEmail.id});
		expect(failed.unwrapErr().kind).toBe('not_found');
		expect(logAgentRequest).not.toHaveBeenCalled();

		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));
		const unlogged = await runAgentTool(caller, 'mail-1', 'emails_list', {});
		expect(unlogged.unwrapErr().kind).toBe('db_error');
	});
});
