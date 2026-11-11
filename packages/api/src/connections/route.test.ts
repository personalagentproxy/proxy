import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findIntegration} from '@proxy/integrations';

const listConnectionsWithCredential = mock();
const getConnectionWithCredential = mock();
const deleteConnection = mock();
const setConnectionDefaults = mock();
const updateConnectionName = mock();
const countSameAccountConnections = mock();
const setConnectionSharing = mock();
const createConnection = mock();
const moveConnection = mock();

mock.module('@proxy/db/connection', () => ({
	setConnectionSharing,
	createConnection,
	moveConnection,
	listConnectionsWithCredential,
	getConnectionWithCredential,
	deleteConnection,
	setConnectionDefaults,
	updateConnectionName,
	countSameAccountConnections,
}));

// The organization's people: Alex, its owner, Dana and Sam.
const people = [
	{orgId: 'org-1', userId: 'user-1', name: 'Alex'},
	{orgId: 'org-1', userId: 'user-2', name: 'Dana'},
	{orgId: 'org-1', userId: 'user-3', name: 'Sam'},
];

// Another organization Alex is in, which a connection of theirs can move into.
const otherOrg = {id: 'org-2', slug: 'side-project', name: 'Side project', onboardedAt: null, role: 'owner', experiments: []};
const getMemberOrganization = mock();

mock.module('@proxy/db/organization', () => ({
	getMemberOrganization,
	listMemberNames: mock(async (asked: Array<{userId: string}>) => Ok(people.filter((person) => asked.some((one) => one.userId === person.userId)))),
	listMembers: mock(async () => Ok(people)),
}));

const owner = {orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []};
// Someone else in the organization, who only uses what is shared.
const member = {...owner, userId: 'user-2', role: 'member'};
const requireViewer = mock(async (): Promise<unknown> => Ok(owner));

// Whether Files are offered: the experiment and a place for the bytes, which the tests of making a
// drive say; the built-in drive is made elsewhere.
const filesOffered = mock(async () => true);
mock.module('../native/files/connections', () => ({filesOffered, ensureFilesConnection: mock(async () => Ok(undefined))}));

mock.module('../utils/user-org', () => ({requireViewer, requireOwner: requireViewer}));

const warn = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn, error: mock()},
	serializeError: mock(() => ({})),
}));

// Readable stand-ins for encryption, so a test can write the credential it means.
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

mock.module('../utils/env', () => ({env: {PLAID_CLIENT_ID: 'plaid-client', PLAID_SECRET: 'plaid-secret', PLAID_ENV: 'sandbox'}}));

// Of the integrations' modules, what Google and Plaid undo at the provider and Google's partial consent.
const {REVOKE_GOOGLE} = await import('./google/revoke');
const {unavailableGoogleConnectionActions} = await import('./google/unavailable');
const {REMOVE_PLAID_ITEM} = await import('./plaid/revoke');
const integrations = [
	{id: 'google', connectors: {}, revoke: REVOKE_GOOGLE, unavailableActions: unavailableGoogleConnectionActions},
	{id: 'plaid', connectors: {}, revoke: REMOVE_PLAID_ITEM},
];

mock.module('./integrations', () => ({apiIntegration: (id: string) => integrations.find((integration) => integration.id === id)}));

// Google's revoke endpoint and Plaid's: each request, and its answer.
const google = {requests: [] as Array<{url: string; body: URLSearchParams; text: string}>, status: 200};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const text = typeof init?.body === 'string' ? init.body : '';
	google.requests.push({url, body: new URLSearchParams(text), text});
	return new Response(google.status === 200 ? '{}' : '{"error":"invalid_token"}', {status: google.status});
}) as typeof fetch);

const emailRow = {
	id: 'conn-1',
	integrationId: 'email',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	tools: null,
	name: null,
	defaults: [{actionId: 'read'}],
	credential: 'enc:{}',
};

function googleRow(scopes: string[]) {
	const credential = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes, email: 'alex@example.com'};
	return {...emailRow, id: 'conn-2', integrationId: 'google', defaults: [], credential: `enc:${JSON.stringify(credential)}`};
}

// The person unticked Drive on Google's consent screen.
const withoutDrive = googleRow([
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/calendar.events.freebusy',
	'https://www.googleapis.com/auth/contacts',
	'https://www.googleapis.com/auth/contacts.other.readonly',
	'https://www.googleapis.com/auth/tasks',
]);

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {
		user: {userId: 'user-1', email: 'alex@example.com'},
		params,
		body,
	} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	requireViewer.mockResolvedValue(Ok(owner));
	google.requests = [];
	google.status = 200;
	countSameAccountConnections.mockResolvedValue(Ok(0));
	listConnectionsWithCredential.mockResolvedValue(Ok([emailRow]));
	getConnectionWithCredential.mockResolvedValue(Ok(emailRow));
	deleteConnection.mockResolvedValue(Ok(true));
	setConnectionDefaults.mockResolvedValue(Ok(undefined));
	setConnectionSharing.mockResolvedValue(Ok(undefined));
	moveConnection.mockResolvedValue(Ok(true));
	getMemberOrganization.mockResolvedValue(Ok(otherOrg));
});

describe('handleListConnectionsRoute', () => {
	test("lists the organization's connections with their default actions", async () => {
		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(listConnectionsWithCredential).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}));
		const [connection] = result.unwrap().connections;
		expect(connection).toMatchObject({id: 'conn-1', integrationId: 'email', account: 'alex@example.com'});
		expect(connection?.defaults).toEqual(['read']);
		expect(connection?.unavailable).toEqual([]);
	});

	test("a Google credential that can't be read leaves the rest listed, itself with no action available", async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([emailRow, {...googleRow([]), credential: 'v1.other-key'}]));
		const {handleListConnectionsRoute} = await import('./route');
		const {connections} = (await handleListConnectionsRoute(makeRequest())).unwrap();

		const every = findIntegration('google')?.actions.map((action) => action.id);
		expect(connections.map((connection) => [connection.id, connection.unavailable])).toEqual([
			['conn-1', []],
			['conn-2', every ?? []],
		]);
	});

	test("says which actions a Google connection's sign-in didn't cover, never the credential", async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([emailRow, withoutDrive]));

		const {handleListConnectionsRoute} = await import('./route');
		const [, connection] = (await handleListConnectionsRoute(makeRequest())).unwrap().connections;

		expect(connection).toEqual({
			id: 'conn-2',
			orgId: 'org-1',
			integrationId: 'google',
			account: 'alex@example.com',
			ownerUserId: 'user-1',
			owner: 'Alex',
			sharedWithEveryone: false,
			sharedWith: [],
			shared: false,
			builtIn: false,
			defaults: [],
			tools: null,
			name: null,
			unavailable: ['readFiles', 'createFiles', 'editFiles', 'trashFiles'],
			signInNeeded: false,
		});
	});

	test('a connection without a credential needs a sign-in, and has every action unavailable until then', async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([{...withoutDrive, id: 'conn-3', integrationId: 'linear', account: 'mcp.linear.app/mcp', credential: null}]));

		const {handleListConnectionsRoute} = await import('./route');
		const [connection] = (await handleListConnectionsRoute(makeRequest())).unwrap().connections;

		expect(connection).toMatchObject({integrationId: 'linear', unavailable: ['read', 'create', 'edit'], signInNeeded: true});
	});

	test('an organization the person isn’t in is not found', async () => {
		requireViewer.mockResolvedValueOnce(Err(ApiErr.notFound('organization', 'elsewhere')) as never);

		const {handleListConnectionsRoute} = await import('./route');
		const result = await handleListConnectionsRoute(makeRequest());

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleGetConnectionRoute', () => {
	test("looks the connection up in the user's organization", async () => {
		const {handleGetConnectionRoute} = await import('./route');
		const result = await handleGetConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(getConnectionWithCredential).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-1');
		expect(result.unwrap().id).toBe('conn-1');
	});

	test('an unknown connection is not found', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));

		const {handleGetConnectionRoute} = await import('./route');
		const result = await handleGetConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleRenameConnectionRoute', () => {
	test('renames the connection, an empty name being none of its own', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		const {handleRenameConnectionRoute} = await import('./route');
		const renamed = (await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ' Work mail '}))).unwrap();
		expect(updateConnectionName).toHaveBeenCalledWith({connectionId: 'conn-1', name: 'Work mail'});
		expect(renamed.name).toBe('Work mail');

		const cleared = (await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ''}))).unwrap();
		expect(updateConnectionName).toHaveBeenLastCalledWith({connectionId: 'conn-1', name: null});
		expect(cleared.name).toBeNull();
	});

	test('a custom MCP server needs a name, and the vault keeps its own', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'mcp', tools: '[]', name: 'Docs'}));
		const {handleRenameConnectionRoute} = await import('./route');
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ' '}))).unwrapErr().kind).toBe('validation_error');

		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'vault'}));
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Mine'}))).unwrapErr().kind).toBe('forbidden');
		expect(updateConnectionName).not.toHaveBeenCalled();
	});

	test('a vault a member made is renamed, to something', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'vault', name: 'Finance', credential: null}));
		const {handleRenameConnectionRoute} = await import('./route');
		const unnamed = await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ''}));
		const renamed = await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Money'}));

		expect(unnamed.unwrapErr().kind).toBe('validation_error');
		expect(renamed.unwrap().name).toBe('Money');
		expect(updateConnectionName).toHaveBeenCalledTimes(1);
	});
});

describe('handleDeleteConnectionRoute', () => {
	test('deletes the connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(deleteConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-1');
		expect(result.isOk()).toBe(true);
	});

	test('revokes a Google connection at Google first, its refresh token ending the whole grant', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(google.requests.map(({url, body}) => [url, body.get('token')])).toEqual([['https://oauth2.googleapis.com/revoke', 'refresh-1']]);
		expect(deleteConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-2');
	});

	test('keeps the grant at Google while another connection, in any organization, is for the same account', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));
		countSameAccountConnections.mockResolvedValue(Ok(1));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(countSameAccountConnections).toHaveBeenCalledWith('conn-2', ['conn-2']);
		expect(google.requests).toEqual([]);
		expect(deleteConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-2');
	});

	test('deletes a Google connection even when Google turns the revoke down', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));
		google.status = 400;

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-2'}));

		expect(result.isOk()).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(deleteConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-2');
	});

	test('removes a bank login at Plaid first, which ends what Plaid bills for it', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, id: 'conn-3', integrationId: 'plaid', credential: 'enc:{"accessToken":"access-sandbox-1","itemId":"item-1"}'}));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-3'}));

		expect(result.isOk()).toBe(true);
		expect(google.requests.map(({url, text}) => [url, JSON.parse(text)])).toEqual([['https://sandbox.plaid.com/item/remove', {access_token: 'access-sandbox-1'}]]);
		expect(deleteConnection).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-3');
	});

	test('asks nothing of the provider for any other connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(google.requests).toEqual([]);
	});

	test('a member’s built-in vault and Sandboxes stay, and a vault they made goes as any connection', async () => {
		const {handleDeleteConnectionRoute} = await import('./route');
		const kept = [];
		for (const integrationId of ['vault', 'sandbox']) {
			getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId, credential: null}));
			kept.push(await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'})));
		}
		expect(kept.map((result) => result.unwrapErr().kind)).toEqual(['forbidden', 'forbidden']);
		expect(deleteConnection).not.toHaveBeenCalled();

		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'vault', name: 'Finance', credential: null}));
		const made = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}));

		expect(made.isOk()).toBe(true);
		expect(deleteConnection).toHaveBeenCalledTimes(1);
	});

	test('an unknown connection is not found', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));

		const {handleDeleteConnectionRoute} = await import('./route');
		const result = await handleDeleteConnectionRoute(makeRequest({connectionId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleSetConnectionDefaultsRoute', () => {
	test('turns default actions on and off', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: true, send: false}}));

		expect(setConnectionDefaults).toHaveBeenCalledWith({connectionId: 'conn-1', actions: {read: true, send: false}});
		expect(result.isOk()).toBe(true);
	});

	test('refuses an action the integration does not have', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {readEntries: true}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(setConnectionDefaults).not.toHaveBeenCalled();
	});

	test("refuses turning on an action the sign-in didn't cover, saying how to allow it", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-2'}, {actions: {readFiles: true}}));

		expect(result.unwrapErr()).toMatchObject({kind: 'validation_error', message: "Google didn't allow Read files at sign-in. Sign in to Google again to allow it."});
		expect(setConnectionDefaults).not.toHaveBeenCalled();
	});

	test("turns off an action the sign-in didn't cover", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(withoutDrive));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-2'}, {actions: {readFiles: false}}));

		expect(result.unwrap().unavailable).toEqual(['readFiles', 'createFiles', 'editFiles', 'trashFiles']);
		expect(setConnectionDefaults).toHaveBeenCalledWith({connectionId: 'conn-2', actions: {readFiles: false}});
	});

	test('refuses a setting that is not on or off', async () => {
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: null}}));

		expect(result.unwrapErr().kind).toBe('parse_error');
	});

	test('propagates db errors', async () => {
		setConnectionDefaults.mockResolvedValue(Err(ApiErr.dbError(new Error('boom'))));

		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: true}}));

		expect(result.unwrapErr().kind).toBe('db_error');
	});
});

describe('who may change a shared connection', () => {
	// Dana's, shared with every member.
	const everyones = {...emailRow, ownerUserId: 'user-2', sharedWithEveryone: true};
	// Alex's, shared with Dana by name.
	const danas = {...emailRow, shares: [{userId: 'user-2'}]};

	test('a member it is shared with sees it, but may not rename, disconnect or share it, nor change its defaults', async () => {
		requireViewer.mockResolvedValue(Ok(member));
		getConnectionWithCredential.mockResolvedValue(Ok(danas));
		const route = await import('./route');
		const seen = await route.handleGetConnectionRoute(makeRequest({connectionId: 'conn-1'}));
		const refused = await Promise.all([
			route.handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Theirs'})),
			route.handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'})),
			route.handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: false}})),
			route.handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: true, userIds: []})),
		]);

		expect(seen.unwrap()).toMatchObject({id: 'conn-1', shared: true, sharedWithEveryone: false, owner: 'Alex', sharedWith: [{userId: 'user-2', name: 'Dana'}]});
		expect(refused.map((result) => result.unwrapErr().kind)).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden']);
		expect(updateConnectionName).not.toHaveBeenCalled();
		expect(deleteConnection).not.toHaveBeenCalled();
		expect(setConnectionDefaults).not.toHaveBeenCalled();
		expect(setConnectionSharing).not.toHaveBeenCalled();
	});

	test('whoever’s it is changes it, member or not, and so does the organization’s owner while every member has it', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(everyones));
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const byOrgOwner = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: false}}));
		requireViewer.mockResolvedValue(Ok(member));
		const byItsOwner = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: false}}));

		expect(byOrgOwner.isOk()).toBe(true);
		expect(byItsOwner.isOk()).toBe(true);
		expect(setConnectionDefaults).toHaveBeenCalledTimes(2);
	});

	test('the organization’s owner changes nothing of one shared with them by name alone', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, ownerUserId: 'user-2', shares: [{userId: 'user-1'}]}));
		const {handleSetConnectionDefaultsRoute} = await import('./route');
		const result = await handleSetConnectionDefaultsRoute(makeRequest({connectionId: 'conn-1'}, {actions: {read: false}}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(setConnectionDefaults).not.toHaveBeenCalled();
	});

	test('another member’s own connection is not found, even for the owner', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));
		const {handleGetConnectionRoute, handleDeleteConnectionRoute} = await import('./route');
		const got = await handleGetConnectionRoute(makeRequest({connectionId: 'conn-9'}));
		const deleted = await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-9'}));

		expect(getConnectionWithCredential).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'conn-9');
		expect(got.unwrapErr().kind).toBe('not_found');
		expect(deleted.unwrapErr().kind).toBe('not_found');
		expect(deleteConnection).not.toHaveBeenCalled();
	});
});

describe('handleSetConnectionSharingRoute', () => {
	test('shares a connection with members by name, with everyone, or both, all of it at once', async () => {
		const {handleSetConnectionSharingRoute} = await import('./route');
		const result = await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: true, userIds: ['user-2', 'user-3']}));

		expect(setConnectionSharing).toHaveBeenCalledWith({connectionId: 'conn-1', ownerUserId: 'user-1', everyone: true, userIds: ['user-2', 'user-3']});
		expect(result.unwrap()).toMatchObject({
			shared: true,
			sharedWithEveryone: true,
			sharedWith: [
				{userId: 'user-2', name: 'Dana'},
				{userId: 'user-3', name: 'Sam'},
			],
		});
	});

	test('takes it back from everyone it was shared with', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, sharedWithEveryone: true, shares: [{userId: 'user-2'}]}));
		const {handleSetConnectionSharingRoute} = await import('./route');
		const result = await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: false, userIds: []}));

		expect(setConnectionSharing).toHaveBeenCalledWith({connectionId: 'conn-1', ownerUserId: 'user-1', everyone: false, userIds: []});
		expect(result.unwrap()).toMatchObject({shared: false, sharedWithEveryone: false, sharedWith: []});
	});

	test('its owner is never among those it is shared with, and nobody is twice', async () => {
		const {handleSetConnectionSharingRoute} = await import('./route');
		await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: false, userIds: ['user-1', 'user-2', 'user-2']}));

		expect(setConnectionSharing).toHaveBeenCalledWith(expect.objectContaining({userIds: ['user-2']}));
	});

	test('refuses someone who isn’t in the organization', async () => {
		const {handleSetConnectionSharingRoute} = await import('./route');
		const result = await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: false, userIds: ['user-2', 'stranger']}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(setConnectionSharing).not.toHaveBeenCalled();
	});

	test('a member’s built-in vault and Sandboxes stay their own, and a vault they made is shared as any connection', async () => {
		const {handleSetConnectionSharingRoute} = await import('./route');
		const refused = [];
		for (const integrationId of ['vault', 'sandbox']) {
			getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId, credential: null}));
			refused.push(await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: true, userIds: []})));
		}
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'vault', name: 'Finance', credential: null}));
		const made = await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: false, userIds: ['user-2']}));

		expect(refused.map((result) => result.unwrapErr().kind)).toEqual(['forbidden', 'forbidden']);
		expect(made.unwrap()).toMatchObject({builtIn: false, name: 'Finance', sharedWith: [{userId: 'user-2', name: 'Dana'}]});
		expect(setConnectionSharing).toHaveBeenCalledTimes(1);
	});
});

describe('handleMoveConnectionRoute', () => {
	test('moves the person’s connection into another organization of theirs, shared with nobody there', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, sharedWithEveryone: true, shares: [{userId: 'user-2'}]}));
		const {handleMoveConnectionRoute} = await import('./route');
		const result = await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'side-project'}));

		expect(getMemberOrganization).toHaveBeenCalledWith('user-1', 'side-project');
		expect(moveConnection).toHaveBeenCalledWith({connectionId: 'conn-1', ownerUserId: 'user-1', fromOrgId: 'org-1', toOrgId: 'org-2', account: 'alex@example.com'});
		expect(result.unwrap()).toMatchObject({orgId: 'org-2', shared: false, sharedWithEveryone: false, sharedWith: []});
	});

	test('a vault the person made takes its new organization’s name for its account', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'vault', account: 'Workspace', name: 'Finance', credential: null}));
		const {handleMoveConnectionRoute} = await import('./route');
		const result = await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'side-project'}));

		expect(moveConnection).toHaveBeenCalledWith(expect.objectContaining({account: 'Side project'}));
		expect(result.unwrap()).toMatchObject({account: 'Side project', name: 'Finance'});
	});

	test('only whoever’s it is moves it, even the organization’s owner may not move another member’s', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, ownerUserId: 'user-2', sharedWithEveryone: true}));
		const {handleMoveConnectionRoute} = await import('./route');
		const result = await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'side-project'}));

		expect(result.unwrapErr().kind).toBe('forbidden');
		expect(moveConnection).not.toHaveBeenCalled();
	});

	test('a member’s built-in vault and Sandboxes stay where they are', async () => {
		const {handleMoveConnectionRoute} = await import('./route');
		const refused = [];
		for (const integrationId of ['vault', 'sandbox']) {
			getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId, credential: null}));
			refused.push(await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'side-project'})));
		}

		expect(refused.map((result) => result.unwrapErr().kind)).toEqual(['forbidden', 'forbidden']);
		expect(moveConnection).not.toHaveBeenCalled();
	});

	test('refuses an organization the person isn’t in, and the one it is in already', async () => {
		const {handleMoveConnectionRoute} = await import('./route');
		getMemberOrganization.mockResolvedValue(Ok(null));
		const stranger = await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'elsewhere'}));
		getMemberOrganization.mockResolvedValue(Ok({...otherOrg, id: 'org-1', slug: 'org-1'}));
		const same = await handleMoveConnectionRoute(makeRequest({connectionId: 'conn-1'}, {org: 'org-1'}));

		expect(stranger.unwrapErr().kind).toBe('not_found');
		expect(same.unwrapErr().kind).toBe('validation_error');
		expect(moveConnection).not.toHaveBeenCalled();
	});
});

describe('handleCreateVaultRoute', () => {
	const madeVault = {...emailRow, id: 'conn-7', integrationId: 'vault', account: 'Workspace', name: 'Finance', defaults: [{actionId: 'readEntries'}, {actionId: 'writeEntries'}]};

	test('makes a named vault of the person’s, which agents read and write by default', async () => {
		const {credential: _credential, ...row} = madeVault;
		createConnection.mockResolvedValue(Ok(row));
		const {handleCreateVaultRoute} = await import('./route');
		const result = await handleCreateVaultRoute(makeRequest({}, {name: ' Finance '}));

		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			ownerUserId: 'user-1',
			sharedWithEveryone: false,
			integrationId: 'vault',
			account: 'Workspace',
			name: 'Finance',
			defaults: ['readEntries', 'writeEntries'],
		});
		expect(result.unwrap()).toMatchObject({id: 'conn-7', name: 'Finance', builtIn: false, shared: false, signInNeeded: false});
	});

	test('shares it with every member from the start where asked', async () => {
		const {credential: _credential, ...row} = madeVault;
		createConnection.mockResolvedValue(Ok({...row, sharedWithEveryone: true}));
		const {handleCreateVaultRoute} = await import('./route');
		const result = await handleCreateVaultRoute(makeRequest({}, {name: 'Finance', shared: true}));

		expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({sharedWithEveryone: true}));
		expect(result.unwrap()).toMatchObject({shared: true, sharedWithEveryone: true});
	});

	test('a vault needs a name', async () => {
		const {handleCreateVaultRoute} = await import('./route');
		const result = await handleCreateVaultRoute(makeRequest({}, {name: '  '}));

		expect(result.unwrapErr().kind).toBe('parse_error');
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('handleCreateDriveRoute', () => {
	const madeDrive = {
		...emailRow,
		id: 'conn-8',
		integrationId: 'files',
		account: 'Workspace',
		name: 'Launch',
		defaults: [{actionId: 'readFiles'}, {actionId: 'createFiles'}, {actionId: 'editFiles'}, {actionId: 'trashFiles'}],
	};

	test('makes a named drive of the person’s, or every member’s where asked, which agents read and write by default', async () => {
		const {credential: _credential, ...row} = madeDrive;
		createConnection.mockResolvedValue(Ok(row));
		const {handleCreateDriveRoute} = await import('./route');
		const result = await handleCreateDriveRoute(makeRequest({}, {name: ' Launch '}));

		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			ownerUserId: 'user-1',
			sharedWithEveryone: false,
			integrationId: 'files',
			account: 'Workspace',
			name: 'Launch',
			defaults: ['readFiles', 'createFiles', 'editFiles', 'trashFiles'],
		});
		// One a member made is theirs to rename, share and delete, as their built-in one isn't.
		expect(result.unwrap()).toMatchObject({id: 'conn-8', name: 'Launch', builtIn: false, shared: false, signInNeeded: false});

		createConnection.mockResolvedValue(Ok({...row, sharedWithEveryone: true}));
		const shared = await handleCreateDriveRoute(makeRequest({}, {name: 'Launch', shared: true}));
		expect(createConnection).toHaveBeenLastCalledWith(expect.objectContaining({sharedWithEveryone: true}));
		expect(shared.unwrap()).toMatchObject({shared: true, sharedWithEveryone: true});
	});

	test('a drive needs a name, and is made only where Files are offered', async () => {
		const {handleCreateDriveRoute} = await import('./route');

		expect((await handleCreateDriveRoute(makeRequest({}, {name: '  '}))).unwrapErr().kind).toBe('parse_error');
		filesOffered.mockResolvedValueOnce(false);
		expect((await handleCreateDriveRoute(makeRequest({}, {name: 'Launch'}))).unwrapErr().kind).toBe('forbidden');
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe('a drive, as a connection', () => {
	test('the person’s own keeps its name and is never shared or deleted; one they made is renamed, to something, shared and deleted', async () => {
		updateConnectionName.mockResolvedValue(Ok(undefined));
		const {handleRenameConnectionRoute, handleDeleteConnectionRoute, handleSetConnectionSharingRoute} = await import('./route');

		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'files', name: null, credential: null}));
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Mine'}))).unwrapErr().kind).toBe('forbidden');
		expect((await handleSetConnectionSharingRoute(makeRequest({connectionId: 'conn-1'}, {everyone: true, userIds: []}))).unwrapErr().kind).toBe('forbidden');
		expect((await handleDeleteConnectionRoute(makeRequest({connectionId: 'conn-1'}))).unwrapErr().kind).toBe('forbidden');

		getConnectionWithCredential.mockResolvedValue(Ok({...emailRow, integrationId: 'files', name: 'Launch', credential: null}));
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: ''}))).unwrapErr()).toEqual(ApiErr.validationError('A drive needs a name'));
		expect((await handleRenameConnectionRoute(makeRequest({connectionId: 'conn-1'}, {name: 'Launch 2'}))).unwrap()).toMatchObject({name: 'Launch 2', builtIn: false});
	});
});
