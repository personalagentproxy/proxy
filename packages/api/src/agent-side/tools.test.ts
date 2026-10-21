import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findIntegration, integrationFor, type Integration} from '@proxy/integrations';

const getAgent = mock();

mock.module('@proxy/db/agent', () => ({getAgent}));

const logAgentRequest = mock();

mock.module('@proxy/db/audit', () => ({logAgentRequest}));

const getAgentTask = mock();

mock.module('@proxy/db/task', () => ({getAgentTask, createAgentTask: mock(), finishAgentTask: mock(), listOpenAgentTasks: mock(), getOrgTask: mock()}));

const listConnectionsWithCredential = mock();

mock.module('@proxy/db/connection', () => ({listConnectionsWithCredential, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// Readable stand-ins for encryption, so a test can write the credential it means.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const loadConnection = mock();

mock.module('../records/target', () => ({loadConnection}));

const callCustomTool = mock();

mock.module('../connections/custom/custom-mcp', () => ({callCustomTool}));

function integration(id: string): Integration {
	const found = findIntegration(id);
	if (!found) {
		throw new Error(`No integration ${id}`);
	}
	return found;
}

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'dot', name: 'Dots', experiments: []};
const caller = {agent: signedIn, via: 'mcp' as const, taskId: 'task-1'};

// The task every run here is for, under way.
// Started a moment ago, so it is under way whenever the tests run.
const task = {id: 'task-1', agentId: 'agent-1', title: 'Find the Visa', goal: 'Look up the card number', via: 'mcp', createdAt: new Date(), finishedAt: null};

const vaultConnection = {id: 'vault-1', integrationId: 'vault', account: "Alex's Workspace", createdAt: new Date(), tools: null, name: null, defaults: [{actionId: 'readEntries'}], credential: null};
const emailConnection = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), tools: null, name: null, defaults: [{actionId: 'read'}], credential: 'v1.x.y.z'};
const notionConnection = {
	id: 'notion-1',
	integrationId: 'notion',
	account: 'alex@example.com · Acme',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [{actionId: 'read'}, {actionId: 'create'}],
	credential: 'v1.x.y.z',
};

// Read files is on by default, but the person unticked Drive on Google's consent screen.
const googleConnection = {
	id: 'google-1',
	integrationId: 'google',
	account: 'alex@example.com',
	createdAt: new Date(),
	defaults: [{actionId: 'readFiles'}],
	credential: `enc:${JSON.stringify({accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'], email: 'alex@example.com'})}`,
};

// Edits the vault of its own, and doesn't read the mailbox.
const agent = {
	id: 'agent-1',
	providerId: 'dot',
	name: 'Dots',
	grants: [
		{connectionId: 'vault-1', actionId: 'writeEntries', allowed: true},
		{connectionId: 'mail-1', actionId: 'read', allowed: false},
	],
};

// Reads the mailbox by default, writes drafts, archives and sends of its own.
const triage = {
	...agent,
	grants: ['write', 'archive', 'send'].map((actionId) => ({connectionId: 'mail-1', actionId, allowed: true})),
};

const entry = {id: 'rec-1', values: {title: 'Home address', type: 'Address', content: '1 Main St'}, updatedAt: '2026-10-01T00:00:00.000Z'};
const inboxEmail = {id: 'inbox-7-12', values: {folder: 'Inbox', subject: 'Invoice #20931'}, updatedAt: '2026-10-01T00:00:00.000Z'};
const draft = {id: 'drafts-7-3', values: {folder: 'Draft', from: 'alex@example.com', to: 'sam@example.com', subject: 'Re: Q3 planning', body: 'Draft body'}, updatedAt: '2026-10-01T00:00:00.000Z'};

const archive = mock();
const send = mock();
const sendNew = mock();
const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock(), commands: {archive, send}, newCommands: {sendNew}};

function useConnection(connection: typeof vaultConnection | typeof emailConnection | typeof notionConnection | typeof googleConnection) {
	loadConnection.mockResolvedValue(Ok({connection, integration: integration(connection.integrationId), connector}));
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgent.mockResolvedValue(Ok(agent));
	getAgentTask.mockResolvedValue(Ok(task));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	listConnectionsWithCredential.mockResolvedValue(Ok([vaultConnection, emailConnection, googleConnection]));
	connector.list.mockResolvedValue(Ok({records: [entry], nextPage: null}));
	connector.get.mockResolvedValue(Ok(entry));
	useConnection(vaultConnection);
});

describe('listAgentConnections', () => {
	test('lists what the agent can do with each connection, leaving out those it can do nothing with', async () => {
		const {listAgentConnections} = await import('./tools');
		const result = await listAgentConnections(signedIn);

		expect(result.unwrap()).toEqual({
			agent: {id: 'agent-1', providerId: 'dot', name: 'Dots'},
			connections: [{id: 'vault-1', integrationId: 'vault', account: "Alex's Workspace", actions: ['readEntries', 'writeEntries'], tools: null, name: null}],
		});
	});
});

describe("actions the connection's sign-in didn't cover", () => {
	test('are not among what the agent can do, whatever is ticked', async () => {
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'google-1', actionId: 'readFiles', allowed: true}]}));

		const {listAgentConnections} = await import('./tools');
		const result = await listAgentConnections(signedIn);

		expect(result.unwrap().connections.map((connection) => connection.id)).toEqual(['vault-1', 'mail-1']);
	});

	test('offer no tools', async () => {
		useConnection(googleConnection);

		const {listAgentTools} = await import('./tools');
		const result = await listAgentTools(signedIn, 'google-1');

		expect(result.unwrap()).toEqual([]);
	});

	test('running one is refused, saying how to allow it, and logged as denied', async () => {
		useConnection(googleConnection);

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'google-1', 'files_list', {search: 'budget'});

		expect(result.unwrapErr()).toMatchObject({kind: 'validation_error', message: "Google didn't allow Read files at sign-in. Sign in to Google again to allow it."});
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({connectionId: 'google-1', collectionId: 'files', action: 'list', query: 'budget', outcome: 'denied'});
	});

	test("one the agent's own setting turns off anyway is plainly forbidden", async () => {
		getAgent.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'google-1', actionId: 'readFiles', allowed: false}]}));
		useConnection(googleConnection);

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'google-1', 'files_list', {});

		expect(result.unwrapErr().kind).toBe('forbidden');
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
		const result = await runAgentTool(caller, 'vault-1', 'entries_get', {id: 'rec-1'});

		expect(result.unwrap()).toEqual({record: entry});
		expect(connector.get.mock.calls[0]?.[1]).toBe('rec-1');
		expect(logAgentRequest).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			connectionId: 'vault-1',
			collectionId: 'entries',
			action: 'view',
			recordTitle: 'Home address',
			query: null,
			outcome: 'allowed',
			via: 'mcp',
			taskId: 'task-1',
			durationMs: expect.any(Number),
		});
		expect(getAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
	});

	test('a run for a task the agent does not have, or one finished already, is refused unlogged', async () => {
		const {runAgentTool} = await import('./tools');
		getAgentTask.mockResolvedValue(Ok(null));
		const unknown = await runAgentTool(caller, 'info-1', 'cards_get', {id: 'rec-1'});
		getAgentTask.mockResolvedValue(Ok({...task, finishedAt: new Date()}));
		const finished = await runAgentTool(caller, 'info-1', 'cards_get', {id: 'rec-1'});

		expect(unknown.unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task', id: 'task-1'});
		expect(finished.unwrapErr()).toMatchObject({kind: 'conflict', message: expect.stringContaining('Task task-1 (Find the Visa) is finished')});
		expect(connector.get).not.toHaveBeenCalled();
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('a tool without its action is refused and logged as denied, its search too', async () => {
		useConnection(emailConnection);
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_list', {search: ' sizes '});

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'emails', action: 'list', query: 'sizes', outcome: 'denied'});
	});

	test('a list passes the search, the filter field and the page on', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'mail-1', 'emails_list', {search: 'invoice', folder: 'Inbox', page: 'next'});

		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: 'invoice', page: 'next', filter: 'Inbox', parent: null});
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

	test('a select left unchosen, as a form sends it, is left out', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'mail-1', 'emails_list', {folder: ''});

		expect(connector.list.mock.calls[0]?.[1]).toMatchObject({filter: null});
	});

	test('limited to tools that read, or to those that change something, any other is refused unlogged', async () => {
		const {runAgentTool} = await import('./tools');
		const readingAWrite = await runAgentTool(caller, 'vault-1', 'entries_create', {title: 'New'}, {readOnly: true});
		const runningARead = await runAgentTool(caller, 'vault-1', 'entries_list', {}, {readOnly: false});

		expect(readingAWrite.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'entries_create changes something: use run for it'});
		expect(runningARead.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'entries_list only reads: use read for it'});
		expect(connector.create).not.toHaveBeenCalled();
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('a connection outside the organization or a tool the integration lacks is not found and not logged', async () => {
		const {runAgentTool} = await import('./tools');
		const tool = await runAgentTool(caller, 'vault-1', 'entries_send', {});
		loadConnection.mockResolvedValue(Err(ApiErr.notFound('connection', 'elsewhere')));
		const connection = await runAgentTool(caller, 'elsewhere', 'entries_list', {});

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
		expect(connector.update.mock.calls[0]?.slice(1)).toEqual([draft.id, {to: 'sam@example.com', subject: 'Re: Q4 planning', body: 'Draft body'}, draft]);
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

describe('nested collections', () => {
	test('a list opened inside a record is logged with where it was opened', async () => {
		useConnection(notionConnection);
		connector.list.mockResolvedValue(
			Ok({
				records: [],
				nextPage: null,
				trail: [
					{id: 'page-1', title: 'Outreach'},
					{id: 'db-1', title: 'Companies'},
				],
			}),
		);
		const {runAgentTool} = await import('./tools');
		const result = (await runAgentTool(caller, 'notion-1', 'pages_list', {parent: 'db-1'})).unwrap();

		expect('trail' in result && result.trail?.at(-1)).toEqual({id: 'db-1', title: 'Companies'});
		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: null, page: null, filter: null, parent: 'db-1'});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'list', recordTitle: 'Companies', outcome: 'allowed'});
	});

	test('a record made inside another goes to the connector with it, apart from its values', async () => {
		useConnection(notionConnection);
		connector.create.mockResolvedValue(Ok({id: 'page-2', values: {title: 'Globex'}, updatedAt: ''}));
		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'notion-1', 'pages_create', {parent: 'db-1', title: 'Globex'});

		expect(connector.create.mock.calls[0]?.[1]).toEqual({title: 'Globex', properties: '', content: ''});
		expect(connector.create.mock.calls[0]?.[2]).toBe('db-1');
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'create', recordTitle: 'Globex', outcome: 'allowed'});
	});

	test('a collection that is not nested takes no parent', async () => {
		useConnection(emailConnection);
		getAgent.mockResolvedValue(Ok(triage));
		const {runAgentTool} = await import('./tools');
		const listed = await runAgentTool(caller, 'mail-1', 'emails_list', {parent: 'inbox-1'});
		const created = await runAgentTool(caller, 'mail-1', 'emails_create', {parent: 'inbox-1', subject: 'Hi'});

		expect(listed.unwrapErr().kind).toBe('validation_error');
		expect(created.unwrapErr().kind).toBe('validation_error');
		expect(connector.list).not.toHaveBeenCalled();
		expect(connector.create).not.toHaveBeenCalled();
	});
});

// An event's guests are told of what is done to it, so they need Invite guests beyond the write.
describe('a field that needs an action of its own', () => {
	const calendarScopes = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
	const calendarConnection = {
		...googleConnection,
		defaults: [{actionId: 'readEvents'}, {actionId: 'writeEvents'}],
		credential: `enc:${JSON.stringify({accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes: calendarScopes, email: 'alex@example.com'})}`,
	};
	const alone = {
		id: 'alex@example.com:ev1',
		values: {title: 'Focus', kind: 'Event', start: '2026-10-15T09:00:00+02:00', end: '2026-10-15T11:00:00+02:00', guests: ''},
		updatedAt: '2026-10-01T00:00:00.000Z',
	};
	const meeting = {...alone, id: 'alex@example.com:ev2', values: {...alone.values, title: 'Q4 planning', guests: 'sam@example.com'}};
	const inviting = {...agent, grants: [{connectionId: 'google-1', actionId: 'inviteGuests', allowed: true}]};

	beforeEach(() => {
		useConnection(calendarConnection);
		connector.create.mockResolvedValue(Ok(meeting));
		connector.update.mockResolvedValue(Ok(meeting));
	});

	test('an event without guests is made and edited with the write alone', async () => {
		connector.get.mockResolvedValue(Ok(alone));

		const {runAgentTool} = await import('./tools');
		const created = await runAgentTool(caller, 'google-1', 'events_create', {title: 'Focus', start: '2026-10-15T09:00'});
		const updated = await runAgentTool(caller, 'google-1', 'events_update', {id: alone.id, title: 'Deep work'});

		expect(created.isOk()).toBe(true);
		expect(updated.isOk()).toBe(true);
	});

	test('inviting guests, or changing an event that has them, is refused without Invite guests and logged as denied', async () => {
		connector.get.mockResolvedValue(Ok(meeting));

		const {runAgentTool} = await import('./tools');
		const created = await runAgentTool(caller, 'google-1', 'events_create', {title: 'Q4 planning', start: '2026-10-15T09:00', guests: 'sam@example.com'});
		const updated = await runAgentTool(caller, 'google-1', 'events_update', {id: meeting.id, title: 'Q4 planning, moved'});

		expect(created.unwrapErr().kind).toBe('forbidden');
		expect(updated.unwrapErr().kind).toBe('forbidden');
		expect(connector.create).not.toHaveBeenCalled();
		expect(connector.update).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls.map(([entry]) => [entry.action, entry.recordTitle, entry.outcome])).toEqual([
			['create', 'Q4 planning', 'denied'],
			['update', 'Q4 planning, moved', 'denied'],
		]);
	});

	test('with Invite guests, both go through', async () => {
		getAgent.mockResolvedValue(Ok(inviting));
		connector.get.mockResolvedValue(Ok(meeting));

		const {runAgentTool} = await import('./tools');
		const created = await runAgentTool(caller, 'google-1', 'events_create', {title: 'Q4 planning', start: '2026-10-15T09:00', guests: 'sam@example.com'});
		const updated = await runAgentTool(caller, 'google-1', 'events_update', {id: meeting.id, guests: 'sam@example.com, lee@example.com'});

		expect(created.isOk()).toBe(true);
		expect(updated.isOk()).toBe(true);
	});

	test("without Calendar's scopes, Invite guests is refused saying to sign in again", async () => {
		useConnection({...calendarConnection, credential: googleConnection.credential});
		getAgent.mockResolvedValue(Ok(inviting));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'google-1', 'events_create', {title: 'Q4 planning', start: '2026-10-15T09:00', guests: 'sam@example.com'});

		expect(result.unwrapErr()).toMatchObject({kind: 'validation_error', message: "Google didn't allow Create and edit events at sign-in. Sign in to Google again to allow it."});
	});
});

// A custom MCP server's tools, called as they are: by the tool's name, with its params as given.
describe('custom MCP servers', () => {
	const search = {name: 'search_docs', title: 'Search docs', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, annotations: {readOnlyHint: true}};
	const publish = {name: 'publish_doc', inputSchema: {type: 'object', properties: {id: {type: 'string'}}}};
	const customConnection = {
		id: 'mcp-1',
		integrationId: 'mcp',
		account: 'mcp.example.com/mcp',
		createdAt: new Date(),
		tools: JSON.stringify([search, publish]),
		name: null,
		defaults: [{actionId: 'search_docs'}],
		credential: 'v1.x.y.z',
	};

	beforeEach(() => {
		loadConnection.mockResolvedValue(Ok({connection: customConnection, integration: integrationFor({integrationId: 'mcp', tools: [search, publish]}), connector: null}));
		listConnectionsWithCredential.mockResolvedValue(Ok([customConnection]));
		callCustomTool.mockResolvedValue(Ok('3 results'));
	});

	test('lists the connection with the tools the agent may run as its actions, and only those tools', async () => {
		const {listAgentConnections, listAgentTools} = await import('./tools');

		expect((await listAgentConnections(signedIn)).unwrap().connections).toEqual([
			{id: 'mcp-1', integrationId: 'mcp', account: 'mcp.example.com/mcp', actions: ['search_docs'], tools: [search], name: null},
		]);
		expect((await listAgentTools(signedIn, 'mcp-1')).unwrap().map((tool) => tool.name)).toEqual(['search_docs']);
	});

	test('runs a tool the agent may run with its params as given, and logs it by name with them', async () => {
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mcp-1', 'search_docs', {query: 'invoices', limit: 3}, {readOnly: true});

		expect(result.unwrap()).toEqual({text: '3 results'});
		expect(callCustomTool).toHaveBeenCalledWith(customConnection, 'search_docs', {query: 'invoices', limit: 3});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({
			connectionId: 'mcp-1',
			collectionId: 'tools',
			action: 'search_docs',
			recordTitle: null,
			query: '{"query":"invoices","limit":3}',
			outcome: 'allowed',
			via: 'mcp',
		});
	});

	test('a tool the agent may not run is refused and logged as denied; a tool that changes something is not run with read', async () => {
		const {runAgentTool} = await import('./tools');
		expect((await runAgentTool(caller, 'mcp-1', 'publish_doc', {id: 'doc-1'})).unwrapErr().kind).toBe('forbidden');
		expect(callCustomTool).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'tools', action: 'publish_doc', query: '{"id":"doc-1"}', outcome: 'denied'});

		expect((await runAgentTool(caller, 'mcp-1', 'publish_doc', {}, {readOnly: true})).unwrapErr().kind).toBe('validation_error');
		expect((await runAgentTool(caller, 'mcp-1', 'search_docs', 'invoices')).unwrapErr().kind).toBe('validation_error');
		expect(logAgentRequest).toHaveBeenCalledTimes(1);
	});

	test('what the tool answered with is passed on, and a tool that failed is what the server said', async () => {
		callCustomTool.mockResolvedValue(Err(ApiErr.validationError('query is required')));
		const {runAgentTool} = await import('./tools');
		const failed = (await runAgentTool(caller, 'mcp-1', 'search_docs', {})).unwrapErr();

		expect(failed).toEqual(ApiErr.validationError('query is required'));
		expect(logAgentRequest).not.toHaveBeenCalled();
	});
});
