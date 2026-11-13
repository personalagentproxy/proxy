import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findIntegration, integrationFor, type Integration} from '@proxy/integrations';

const getAgentById = mock();

mock.module('@proxy/db/agent', () => ({getAgentById}));

// The member's own Chat connection, made as their connections are listed, is there already.
const createMissingChatConnection = mock(async () => Ok(undefined));
mock.module('@proxy/db/chat', () => ({createMissingChatConnection}));

const logAgentRequest = mock();

mock.module('@proxy/db/audit', () => ({logAgentRequest}));

const getAgentTask = mock();

mock.module('@proxy/db/task', () => ({
	getAgentTask,
	createAgentTask: mock(),
	finishAgentTask: mock(),
	touchAgentTask: mock(async () => Ok(true)),
}));

const listConnectionsWithCredential = mock();

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, listConnectionsWithCredential, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// Readable stand-ins for encryption, so a test can write the credential it means.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const loadConnection = mock();

mock.module('../records/target', () => ({loadConnection}));

// Every collection's connector is the one stand-in below.
mock.module('../records/connectors', () => ({connectorFor: () => connector}));

const callCustomTool = mock();

mock.module('../connections/custom/custom-mcp', () => ({callCustomTool}));

// Of the integrations' modules, Google's partial consent alone, read from its credential.
const {unavailableGoogleConnectionActions} = await import('../connections/google/unavailable');

const apiIntegration = mock((id: string): unknown => (id === 'google' ? {id, connectors: {}, unavailableActions: unavailableGoogleConnectionActions} : undefined));

mock.module('../connections/integrations', () => ({apiIntegration}));

function integration(id: string): Integration {
	const found = findIntegration(id);
	if (!found) {
		throw new Error(`No integration ${id}`);
	}
	return found;
}

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'dot', name: 'Dots', orgSlug: 'org-1', experiments: []};
const caller = {agent: signedIn, via: 'mcp' as const, taskId: 'task-1'};

// The task every run here is for, under way.
// Started a moment ago, so it is under way whenever the tests run.
const task = {id: 'task-1', agentId: 'agent-1', title: 'Find the Visa', goal: 'Look up the card number', via: 'mcp', createdAt: new Date(), finishedAt: null, lastActiveAt: new Date()};

const vaultConnection = {
	id: 'vault-1',
	integrationId: 'vault',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: "Alex's Workspace",
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [{actionId: 'readEntries'}],
	credentialRejectedAt: null,
	credential: null,
};
const emailConnection = {
	id: 'mail-1',
	integrationId: 'email',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [{actionId: 'read'}],
	credentialRejectedAt: null,
	credential: 'v1.x.y.z',
};
const notionConnection = {
	id: 'notion-1',
	integrationId: 'notion',
	account: 'alex@example.com · Acme',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [{actionId: 'read'}, {actionId: 'create'}],
	credentialRejectedAt: null,
	credential: 'v1.x.y.z',
};

// Read files is on by default, but the person unticked Drive on Google's consent screen.
const googleConnection = {
	id: 'google-1',
	integrationId: 'google',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date(),
	defaults: [{actionId: 'readFiles'}],
	credentialRejectedAt: null,
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
const draft = {
	id: 'drafts-7-3',
	values: {folder: 'Draft', from: 'alex@example.com', to: 'sam@example.com', cc: 'jo@example.com', subject: 'Re: Q3 planning', body: 'Draft body'},
	updatedAt: '2026-10-01T00:00:00.000Z',
};

const archive = mock();
const send = mock();
const sendNew = mock();
const read = mock();
const sendReply = mock();
const connector = {list: mock(), get: mock(), create: mock(), update: mock(), remove: mock(), commands: {archive, send}, newCommands: {sendNew, read, send: sendReply}};

function useConnection(connection: typeof vaultConnection | typeof emailConnection | typeof notionConnection | typeof googleConnection) {
	loadConnection.mockResolvedValue(Ok({connection, integration: integration(connection.integrationId)}));
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgentById.mockResolvedValue(Ok(agent));
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
			connections: [{id: 'vault-1', integrationId: 'vault', account: "Alex's Workspace", shared: false, actions: ['readEntries', 'writeEntries'], name: null, signInNeeded: false}],
		});
	});

	test('lists one with no sign-in that it could use once signed in to again, with nothing it can do', async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([vaultConnection, {...notionConnection, orgId: 'org-1', ownerUserId: 'user-1', sharedWithEveryone: false, shares: [], credential: null}]));
		const {listAgentConnections} = await import('./tools');

		expect((await listAgentConnections(signedIn)).unwrap().connections).toEqual([
			{id: 'vault-1', integrationId: 'vault', account: "Alex's Workspace", shared: false, actions: ['readEntries', 'writeEntries'], name: null, signInNeeded: false},
			{id: 'notion-1', integrationId: 'notion', account: 'alex@example.com · Acme', shared: false, actions: [], name: null, signInNeeded: true},
		]);
	});

	test('leaves out one with no sign-in that it could do nothing with anyway', async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([vaultConnection, {...emailConnection, credential: null}]));
		const {listAgentConnections} = await import('./tools');

		expect((await listAgentConnections(signedIn)).unwrap().connections.map((connection) => connection.id)).toEqual(['vault-1']);
	});

	test("reaches the organization's shared connections and its owner's own; a shared agent the shared ones alone", async () => {
		const {listAgentConnections} = await import('./tools');
		await listAgentConnections(signedIn);
		await listAgentConnections({...signedIn, ownerUserId: null});

		expect(listConnectionsWithCredential.mock.calls.map((call) => call[0])).toEqual([
			{orgId: 'org-1', userId: 'user-1'},
			{orgId: 'org-1', userId: null},
		]);
	});

	test('says which connections other members use too, shared with all of them or with some by name', async () => {
		listConnectionsWithCredential.mockResolvedValue(
			Ok([{...vaultConnection, id: 'vault-2', name: 'Team', sharedWithEveryone: true}, {...vaultConnection, id: 'vault-3', name: 'Finance', shares: [{userId: 'user-2'}]}, vaultConnection]),
		);

		const {listAgentConnections} = await import('./tools');
		const result = await listAgentConnections(signedIn);

		expect(result.unwrap().connections.map((connection) => [connection.id, connection.shared])).toEqual([
			['vault-2', true],
			['vault-3', true],
			[vaultConnection.id, false],
		]);
	});
});

describe("actions the connection's sign-in didn't cover", () => {
	test('are not among what the agent can do, whatever is ticked', async () => {
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'google-1', actionId: 'readFiles', allowed: true}]}));

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

	test('running one on a connection with no sign-in is refused without asking its service, and logged as denied', async () => {
		const unsigned = {...notionConnection, orgId: 'org-1', ownerUserId: 'user-1', sharedWithEveryone: false, shares: [], credential: null};
		loadConnection.mockResolvedValue(Ok({connection: unsigned, integration: integration('notion')}));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'notion-1', 'pages_list', {});

		expect(result.unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message:
				"Notion (alex@example.com · Acme) isn't signed in, so nothing was sent to it. Whoever connected it has to sign in again on its page in Personal Agent Proxy; trying again won't help until then.",
		});
		expect(connector.list).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({connectionId: 'notion-1', outcome: 'denied'});
	});

	test("one the agent's own setting turns off anyway is plainly forbidden", async () => {
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'google-1', actionId: 'readFiles', allowed: false}]}));
		useConnection(googleConnection);

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'google-1', 'files_list', {});

		expect(result.unwrapErr().kind).toBe('forbidden');
	});
});

describe('listAgentTools', () => {
	test("the tools of the connection's actions the agent has", async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));

		const {listAgentTools} = await import('./tools');
		const result = await listAgentTools(signedIn, 'mail-1');

		expect(result.unwrap().map((tool) => tool.name)).toEqual(['emails_list', 'emails_get', 'emails_send', 'emails_send_new', 'attachments_read', 'replies_send']);
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
			ownerUserId: 'user-1',
			agentId: 'agent-1',
			connectionId: 'vault-1',
			collectionId: 'entries',
			action: 'view',
			recordTitle: 'Home address',
			query: null,
			outcome: 'allowed',
			via: 'mcp',
			taskId: 'task-1',
			startedAt: expect.any(Number),
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
		getAgentById.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'mail-1', 'emails_list', {search: 'invoice', folder: 'Inbox', page: 'next'});

		expect(connector.list.mock.calls[0]?.[1]).toEqual({search: 'invoice', page: 'next', filter: 'Inbox', parent: null});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'list', query: 'invoice', outcome: 'allowed'});
	});

	test('params the tool does not take are refused before anything runs', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		const unknown = await runAgentTool(caller, 'mail-1', 'emails_list', {filter: 'Inbox'});
		const outsideEnum = await runAgentTool(caller, 'mail-1', 'emails_list', {folder: 'Spam'});
		const missingId = await runAgentTool(caller, 'mail-1', 'emails_get', {});
		const notText = await runAgentTool(caller, 'mail-1', 'emails_get', {id: 7});
		const inherited = await runAgentTool(caller, 'mail-1', 'emails_get', {id: 'inbox-1', constructor: 'x'});

		for (const result of [unknown, outsideEnum, missingId, notText, inherited]) {
			expect(result.unwrapErr().kind).toBe('validation_error');
		}
		expect(connector.list).not.toHaveBeenCalled();
		expect(connector.get).not.toHaveBeenCalled();
	});

	test('a select left unchosen, as a form sends it, is left out', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));

		const {runAgentTool} = await import('./tools');
		await runAgentTool(caller, 'mail-1', 'emails_list', {folder: ''});

		expect(connector.list.mock.calls[0]?.[1]).toMatchObject({filter: null});
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
		getAgentById.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(draft));
		connector.update.mockResolvedValue(Ok({...draft, values: {...draft.values, subject: 'Re: Q4 planning'}}));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: draft.id, subject: 'Re: Q4 planning'});

		expect(result.isOk()).toBe(true);
		expect(connector.update.mock.calls[0]?.slice(1)).toEqual([draft.id, {to: 'sam@example.com', cc: 'jo@example.com', bcc: '', subject: 'Re: Q4 planning', body: 'Draft body'}, draft]);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'update', recordTitle: 'Re: Q4 planning'});
	});

	test('an edit refuses the fields the provider sets', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(draft));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: draft.id, folder: 'Inbox'});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});

	test('only drafts can be edited, even with Write drafts', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_update', {id: inboxEmail.id, subject: 'Hi'});

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(connector.update).not.toHaveBeenCalled();
	});

	test('runs a command on a record, logged with its title, and only where it applies', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
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
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));
		sendNew.mockResolvedValue(Ok(null));
		const values = {to: 'sam@example.com', subject: 'Friday', body: 'See you then.'};

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'emails_send_new', values);

		expect(result.unwrap()).toEqual({record: null});
		expect(sendNew.mock.calls[0]?.[1]).toEqual({...values, cc: '', bcc: ''});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'sendNew', recordTitle: 'Friday', outcome: 'allowed'});
	});

	test('an attachment read by its number is logged by the name it came back with', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'read', allowed: true}]}));
		read.mockResolvedValue(Ok({id: 'inbox-7-12/1', values: {email: 'inbox-7-12', attachment: '1', name: 'Budget.xlsx', content: 'Tab: Q3'}, updatedAt: '2026-10-01T00:00:00.000Z'}));

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'attachments_read', {email: 'inbox-7-12', attachment: '1'});

		expect(result.unwrap()).toMatchObject({record: {values: {name: 'Budget.xlsx'}}});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'attachments', action: 'read', recordTitle: 'Budget.xlsx', outcome: 'allowed'});
	});

	test('a reply is sent with Send and Read, and logged under the subject it went out with', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok({...agent, grants: [{connectionId: 'mail-1', actionId: 'send', allowed: true}]}));
		sendReply.mockResolvedValue(
			Ok({id: '<r1@proxy>', values: {email: 'inbox-7-12', body: 'Thursday works.', replyAll: '', to: 'sam@example.com', cc: '', subject: 'Re: Friday'}, updatedAt: '2026-10-01T00:00:00.000Z'}),
		);

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'replies_send', {email: 'inbox-7-12', body: 'Thursday works.'});

		expect(result.unwrap()).toMatchObject({record: {values: {to: 'sam@example.com', subject: 'Re: Friday'}}});
		expect(sendReply.mock.calls[0]?.[1]).toEqual({email: 'inbox-7-12', body: 'Thursday works.', replyAll: ''});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'replies', action: 'send', recordTitle: 'Re: Friday', outcome: 'allowed'});
	});

	test('a reply is refused with Send but not Read, since it reads the email it answers, and logged as denied', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(
			Ok({
				...agent,
				grants: [
					{connectionId: 'mail-1', actionId: 'send', allowed: true},
					{connectionId: 'mail-1', actionId: 'read', allowed: false},
				],
			}),
		);

		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mail-1', 'replies_send', {email: 'inbox-7-12', body: 'Thursday works.'});

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(sendReply).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'replies', action: 'send', outcome: 'denied'});
	});

	test('a run the provider fails is logged as failed with what went wrong, not as allowed, and passed on', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
		connector.get.mockResolvedValue(Ok(inboxEmail));
		archive.mockResolvedValue(Err(ApiErr.notFound('folder', 'Archive')));

		const {runAgentTool} = await import('./tools');
		const failed = await runAgentTool(caller, 'mail-1', 'emails_archive', {id: inboxEmail.id});
		expect(failed.unwrapErr().kind).toBe('not_found');
		expect(logAgentRequest).toHaveBeenCalledTimes(1);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'archive', recordTitle: 'Invoice #20931', outcome: 'failed', error: 'not_found'});
	});

	test('a sign-in the provider turns down is noted on the connection with the credential used; any other failure is not', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
		connector.list.mockResolvedValue(Err(ApiErr.credentialsRejected()));

		const {runAgentTool} = await import('./tools');
		expect((await runAgentTool(caller, 'mail-1', 'emails_list', {})).unwrapErr().kind).toBe('credentials_rejected');
		expect(markCredentialRejected).toHaveBeenCalledWith({connectionId: 'mail-1', credential: 'v1.x.y.z'});

		markCredentialRejected.mockClear();
		connector.list.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));
		expect((await runAgentTool(caller, 'mail-1', 'emails_list', {})).unwrapErr().kind).toBe('provider_unreachable');
		expect(markCredentialRejected).not.toHaveBeenCalled();
	});

	test("a failure keeps the provider's HTTP status, and a read that failed before it had a record has no title", async () => {
		const tooMany = ApiErr.providerUnreachable({kind: 'http', url: 'https://api.example.com', status: 429, body: 'Slow down, Alex'});
		connector.get.mockResolvedValue(Err(tooMany));
		connector.list.mockResolvedValue(Err(ApiErr.providerUnreachable({kind: 'network', url: 'https://api.example.com', cause: new Error('ECONNRESET')})));

		const {runAgentTool} = await import('./tools');
		expect((await runAgentTool(caller, 'vault-1', 'entries_get', {id: 'rec-1'})).unwrapErr()).toEqual(tooMany);
		expect((await runAgentTool(caller, 'vault-1', 'entries_list', {search: 'passport'})).unwrapErr().kind).toBe('provider_unreachable');

		expect(logAgentRequest.mock.calls.map(([logged]) => logged)).toMatchObject([
			{action: 'view', recordTitle: null, query: null, outcome: 'failed', error: 'provider_unreachable 429'},
			{action: 'list', recordTitle: null, query: 'passport', outcome: 'failed', error: 'provider_unreachable'},
		]);
	});

	test('a run that cannot be logged is not returned', async () => {
		useConnection(emailConnection);
		getAgentById.mockResolvedValue(Ok(triage));
		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {runAgentTool} = await import('./tools');
		const unlogged = await runAgentTool(caller, 'mail-1', 'emails_list', {});
		expect(unlogged.unwrapErr().kind).toBe('db_error');

		connector.list.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const failedUnlogged = await runAgentTool(caller, 'mail-1', 'emails_list', {});
		expect(failedUnlogged.unwrapErr().kind).toBe('db_error');
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
		getAgentById.mockResolvedValue(Ok(triage));
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
		credentialRejectedAt: null,
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
		getAgentById.mockResolvedValue(Ok(inviting));
		connector.get.mockResolvedValue(Ok(meeting));

		const {runAgentTool} = await import('./tools');
		const created = await runAgentTool(caller, 'google-1', 'events_create', {title: 'Q4 planning', start: '2026-10-15T09:00', guests: 'sam@example.com'});
		const updated = await runAgentTool(caller, 'google-1', 'events_update', {id: meeting.id, guests: 'sam@example.com, lee@example.com'});

		expect(created.isOk()).toBe(true);
		expect(updated.isOk()).toBe(true);
	});

	test("without Calendar's scopes, Invite guests is refused saying to sign in again", async () => {
		useConnection({...calendarConnection, credential: googleConnection.credential});
		getAgentById.mockResolvedValue(Ok(inviting));

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
		orgId: 'org-1',
		ownerUserId: 'user-1',
		sharedWithEveryone: false,
		shares: [],
		account: 'mcp.example.com/mcp',
		createdAt: new Date(),
		tools: JSON.stringify([search, publish]),
		name: null,
		defaults: [{actionId: 'search_docs'}],
		credentialRejectedAt: null,
		credential: 'v1.x.y.z',
	};

	beforeEach(() => {
		loadConnection.mockResolvedValue(Ok({connection: customConnection, integration: integrationFor({integrationId: 'mcp', tools: [search, publish]})}));
		listConnectionsWithCredential.mockResolvedValue(Ok([customConnection]));
		callCustomTool.mockResolvedValue(Ok('3 results'));
	});

	test('lists the connection with the tools the agent may run as its actions, and only those tools', async () => {
		const {listAgentConnections, listAgentTools} = await import('./tools');

		expect((await listAgentConnections(signedIn)).unwrap().connections).toEqual([
			{id: 'mcp-1', integrationId: 'mcp', account: 'mcp.example.com/mcp', shared: false, actions: ['search_docs'], name: null, signInNeeded: false},
		]);
		expect((await listAgentTools(signedIn, 'mcp-1')).unwrap().map((tool) => tool.name)).toEqual(['search_docs']);
	});

	test('runs a tool the agent may run with its params as given, and logs it by name with them', async () => {
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'mcp-1', 'search_docs', {query: 'invoices', limit: 3});

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

	test('params are logged in full, however long', async () => {
		const {runAgentTool} = await import('./tools');
		const params = {stdin: 'x'.repeat(5000), query: 'invoices'};
		await runAgentTool(caller, 'mcp-1', 'search_docs', params);

		expect(logAgentRequest.mock.calls[0]?.[0]?.query).toBe(JSON.stringify(params));
	});

	test('a tool the agent may not run is refused and logged as denied; params that are not an object are refused unlogged', async () => {
		const {runAgentTool} = await import('./tools');
		expect((await runAgentTool(caller, 'mcp-1', 'publish_doc', {id: 'doc-1'})).unwrapErr().kind).toBe('forbidden');
		expect(callCustomTool).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'tools', action: 'publish_doc', query: '{"id":"doc-1"}', outcome: 'denied'});

		expect((await runAgentTool(caller, 'mcp-1', 'search_docs', 'invoices')).unwrapErr().kind).toBe('validation_error');
		expect(logAgentRequest).toHaveBeenCalledTimes(1);
	});

	test('what the tool answered with is passed on, and a tool that failed is what the server said, logged as failed', async () => {
		callCustomTool.mockResolvedValue(Err(ApiErr.validationError('query is required')));
		const {runAgentTool} = await import('./tools');
		const failed = (await runAgentTool(caller, 'mcp-1', 'search_docs', {})).unwrapErr();

		expect(failed).toEqual(ApiErr.validationError('query is required'));
		expect(logAgentRequest).toHaveBeenCalledTimes(1);
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'tools', action: 'search_docs', query: null, outcome: 'failed', error: 'validation_error'});
	});
});

// An integration's own tools, run by the api through the runners its module names: the vault with
// a tool counting its entries and one purging them.
describe("an integration's own tools", () => {
	const count = {
		name: 'entries_count',
		title: 'Count entries',
		description: 'How many entries the vault holds.',
		action: 'readEntries',
		readOnly: true as const,
		inputSchema: {type: 'object', properties: {type: {type: 'string'}}},
	};
	const purge = {
		name: 'entries_purge',
		title: 'Purge entries',
		description: 'Deletes every entry older than a number of days.',
		action: 'writeEntries',
		requires: 'readEntries',
		inputSchema: {type: 'object', properties: {days: {type: 'number'}}, required: ['days']},
	};
	const vault = {...integration('vault'), tools: [count, purge]};
	const countEntries = mock();
	const purgeEntries = mock();
	const vaultModule = {id: 'vault', connectors: {}, tools: {entries_count: countEntries, entries_purge: purgeEntries}};

	beforeEach(() => {
		loadConnection.mockResolvedValue(Ok({connection: vaultConnection, integration: vault}));
		apiIntegration.mockImplementation((id) => (id === 'vault' ? vaultModule : undefined));
		countEntries.mockResolvedValue(Ok('3 entries'));
	});

	test('are among the tools the agent has with the connection, as far as its actions go', async () => {
		const {listAgentTools} = await import('./tools');

		expect((await listAgentTools(signedIn, 'vault-1')).unwrap().map((tool) => tool.name)).toEqual([
			'entries_list',
			'entries_get',
			'entries_create',
			'entries_update',
			'entries_delete',
			'entries_count',
			'entries_purge',
		]);
		getAgentById.mockResolvedValue(Ok({...agent, grants: []}));
		expect((await listAgentTools(signedIn, 'vault-1')).unwrap().map((tool) => tool.name)).toEqual(['entries_list', 'entries_get', 'entries_count']);
	});

	test('run by the runner with the params as given, for the caller on the connection, and logged by name with them', async () => {
		const {runAgentTool} = await import('./tools');
		const result = await runAgentTool(caller, 'vault-1', 'entries_count', {type: 'Address'});

		expect(result.unwrap()).toEqual({text: '3 entries'});
		expect(countEntries).toHaveBeenCalledWith({caller, connection: vaultConnection, params: {type: 'Address'}});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({
			connectionId: 'vault-1',
			collectionId: 'tools',
			action: 'entries_count',
			query: '{"type":"Address"}',
			outcome: 'allowed',
			taskId: 'task-1',
		});
	});

	test('one the agent lacks the action for is refused and logged as denied', async () => {
		getAgentById.mockResolvedValue(Ok({...agent, grants: []}));
		const {runAgentTool} = await import('./tools');

		expect((await runAgentTool(caller, 'vault-1', 'entries_purge', {days: 30})).unwrapErr().kind).toBe('forbidden');
		expect(purgeEntries).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({collectionId: 'tools', action: 'entries_purge', query: '{"days":30}', outcome: 'denied'});
		expect(logAgentRequest).toHaveBeenCalledTimes(1);
	});

	test('one the agent lacks the action for runs all the same where the person allowed that very run, as its module says, and is logged as allowed', async () => {
		getAgentById.mockResolvedValue(Ok({...agent, grants: []}));
		const allowed = mock(async (run: {params: Record<string, unknown>}) => Ok(run.params.days === 30));
		apiIntegration.mockImplementation((id) => (id === 'vault' ? {...vaultModule, allowances: {entries_purge: allowed}} : undefined));
		purgeEntries.mockResolvedValue(Ok('Purged'));
		const {runAgentTool} = await import('./tools');

		expect((await runAgentTool(caller, 'vault-1', 'entries_purge', {days: 30})).unwrap()).toEqual({text: 'Purged'});
		expect(allowed).toHaveBeenCalledWith({caller, connection: vaultConnection, params: {days: 30}});
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'entries_purge', outcome: 'allowed'});

		// Another run of the same tool is refused as before.
		logAgentRequest.mockClear();
		expect((await runAgentTool(caller, 'vault-1', 'entries_purge', {days: 7})).unwrapErr().kind).toBe('forbidden');
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'entries_purge', outcome: 'denied'});
	});

	test('what the runner failed with is passed on, logged as failed; a tool without a runner is not found', async () => {
		countEntries.mockResolvedValue(Err(ApiErr.validationError('Not a type of entry')));
		const {runAgentTool} = await import('./tools');

		expect((await runAgentTool(caller, 'vault-1', 'entries_count', {type: 'Nope'})).unwrapErr()).toEqual(ApiErr.validationError('Not a type of entry'));
		expect(logAgentRequest.mock.calls[0]?.[0]).toMatchObject({action: 'entries_count', outcome: 'failed', error: 'validation_error'});

		apiIntegration.mockImplementation((id) => (id === 'vault' ? {...vaultModule, tools: {}} : undefined));
		expect((await runAgentTool(caller, 'vault-1', 'entries_count', {})).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'tool', id: 'entries_count'});
	});
});
