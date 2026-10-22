import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listAgents = mock();
const getAgent = mock();
const createAgent = mock();
const updateAgent = mock();
const deleteAgent = mock();
const setAgentGrants = mock();
const renameAgent = mock();
const isUsernameConflict = mock(() => false);

mock.module('@proxy/db/agent', () => ({
	listAgents,
	getAgent,
	createAgent,
	updateAgent,
	deleteAgent,
	renameAgent,
	setAgentGrants,
	shareAgent: mock(async () => Ok(undefined)),
	isUsernameConflict,
}));

mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

const getConnectionWithCredential = mock();

mock.module('@proxy/db/connection', () => ({getConnectionWithCredential}));

// Readable stand-ins for encryption, so a test can write the credential it means.
mock.module('../utils/secret-crypto', () => ({
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const requireUserOrgId = mock();

mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
	requireUserOrgId,
}));

const agentRow = {
	id: 'agent-1',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	createdById: 'user-1',
	providerId: 'dot',
	name: 'Dots',
	username: 'dots-k7q2',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

function makeRequest(params: Record<string, string> = {}, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	requireUserOrgId.mockResolvedValue(Ok('org-1'));
	getAgent.mockResolvedValue(Ok(agentRow));
	createAgent.mockResolvedValue(Ok(agentRow));
	updateAgent.mockResolvedValue(Ok(true));
	renameAgent.mockResolvedValue(Ok(true));
	setAgentGrants.mockResolvedValue(Ok(undefined));
	getConnectionWithCredential.mockResolvedValue(
		Ok({
			id: 'conn-1',
			integrationId: 'email',
			orgId: 'org-1',
			ownerUserId: 'user-1',
			connectedById: 'user-1',
			account: 'alex@example.com',
			createdAt: new Date(),
			tools: null,
			name: null,
			defaults: [],
			credential: 'enc:{}',
		}),
	);
	isUsernameConflict.mockReturnValue(false);
});

describe('handleCreateAgentRoute', () => {
	test('sends the password once and stores only its hash', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {providerId: 'dot'}));

		const {password, agent} = result.unwrap();
		expect(password).toMatch(/^[\w]{5}-[\w]{5}-[\w]{5}-[\w]{5}$/);
		expect(agent.id).toBe('agent-1');

		const data = createAgent.mock.calls[0]?.[0];
		expect(data.providerId).toBe('dot');
		expect(data.name).toBe('Dots');
		expect(data.username).toMatch(/^dots-[a-z0-9]{4}$/);
		expect(data.passwordHash).not.toContain(password);
		expect(await Bun.password.verify(password, data.passwordHash)).toBe(true);
	});

	test('tries another username when one is taken', async () => {
		const conflict = Err(ApiErr.dbError(new Error('P2002')));
		createAgent.mockResolvedValueOnce(conflict);
		isUsernameConflict.mockReturnValueOnce(true);

		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {providerId: 'dot'}));

		expect(result.isOk()).toBe(true);
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	test('needs a known provider', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {providerId: 'other'}));

		expect(result.unwrapErr().kind).toBe('parse_error');
	});

	test('stores Claude Duet under its shared Claude login', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		await handleCreateAgentRoute(makeRequest({}, {providerId: 'claude-duet'}));

		expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
			providerId: 'claude',
			name: 'Claude',
		});
	});

	test('names a custom agent as the person did, and any number of them', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		await handleCreateAgentRoute(makeRequest({}, {providerId: 'custom', name: '  Cursor '}));
		await handleCreateAgentRoute(makeRequest({}, {providerId: 'custom', name: 'Zed'}));

		expect(createAgent.mock.calls[0]?.[0]).toMatchObject({providerId: 'custom', name: 'Cursor'});
		expect(createAgent.mock.calls[0]?.[0].username).toMatch(/^cursor-[a-z0-9]{4}$/);
		expect(createAgent.mock.calls[1]?.[0]).toMatchObject({providerId: 'custom', name: 'Zed'});
	});

	test('needs a custom agent named, and names any other after its provider unless the person does', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		const unnamed = await handleCreateAgentRoute(makeRequest({}, {providerId: 'custom', name: ' '}));
		const tooLong = await handleCreateAgentRoute(makeRequest({}, {providerId: 'custom', name: 'x'.repeat(61)}));
		await handleCreateAgentRoute(makeRequest({}, {providerId: 'dot'}));
		await handleCreateAgentRoute(makeRequest({}, {providerId: 'dot', name: 'Travel planner'}));

		expect(unnamed.unwrapErr().kind).toBe('validation_error');
		expect(tooLong.unwrapErr().kind).toBe('validation_error');
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(createAgent.mock.calls[0]?.[0].name).toBe('Dots');
		expect(createAgent.mock.calls[1]?.[0]).toMatchObject({providerId: 'dot', name: 'Travel planner'});
	});
});

describe('handleRenameAgentRoute', () => {
	test('renames the agent, trimmed', async () => {
		const {handleRenameAgentRoute} = await import('./route');
		const result = await handleRenameAgentRoute(makeRequest({agentId: 'agent-1'}, {name: ' Travel planner '}));

		expect(renameAgent).toHaveBeenCalledWith('org-1', 'agent-1', 'Travel planner');
		expect(result.unwrap().name).toBe('Travel planner');
	});

	test('needs a name, and not too long a one', async () => {
		const {handleRenameAgentRoute} = await import('./route');
		const empty = await handleRenameAgentRoute(makeRequest({agentId: 'agent-1'}, {name: ' '}));
		const tooLong = await handleRenameAgentRoute(makeRequest({agentId: 'agent-1'}, {name: 'x'.repeat(61)}));

		expect(empty.unwrapErr().kind).toBe('validation_error');
		expect(tooLong.unwrapErr().kind).toBe('validation_error');
		expect(renameAgent).not.toHaveBeenCalled();
	});
});

describe('handleResetAgentPasswordRoute', () => {
	test('stores the hash of a new password and sends the password', async () => {
		const {handleResetAgentPasswordRoute} = await import('./route');
		const {password} = (await handleResetAgentPasswordRoute(makeRequest({agentId: 'agent-1'}))).unwrap();

		const [orgId, agentId, data] = updateAgent.mock.calls[0] ?? [];
		expect([orgId, agentId]).toEqual(['org-1', 'agent-1']);
		expect(await Bun.password.verify(password, data.passwordHash)).toBe(true);
	});

	test('an unknown agent is not found', async () => {
		updateAgent.mockResolvedValue(Ok(false));

		const {handleResetAgentPasswordRoute} = await import('./route');
		const result = await handleResetAgentPasswordRoute(makeRequest({agentId: 'other'}));

		expect(result.unwrapErr().kind).toBe('not_found');
	});
});

describe('handleSetAgentRevokedRoute', () => {
	test('revokes and restores', async () => {
		const {handleSetAgentRevokedRoute} = await import('./route');
		await handleSetAgentRevokedRoute(makeRequest({agentId: 'agent-1'}, {revoked: true}));
		await handleSetAgentRevokedRoute(makeRequest({agentId: 'agent-1'}, {revoked: false}));

		expect(updateAgent.mock.calls[0]?.[2].revokedAt).toBeInstanceOf(Date);
		expect(updateAgent.mock.calls[1]?.[2]).toEqual({revokedAt: null});
	});
});

describe('handleSetAgentGrantsRoute', () => {
	const params = {agentId: 'agent-1', connectionId: 'conn-1'};

	test("sets the agent's own settings, null returning an action to the default", async () => {
		const {handleSetAgentGrantsRoute} = await import('./route');
		const result = await handleSetAgentGrantsRoute(makeRequest(params, {actions: {read: true, send: null}}));

		expect(setAgentGrants).toHaveBeenCalledWith({agentId: 'agent-1', connectionId: 'conn-1', actions: {read: true, send: null}});
		expect(result.isOk()).toBe(true);
	});

	test('refuses an action the integration does not have', async () => {
		const {handleSetAgentGrantsRoute} = await import('./route');
		const result = await handleSetAgentGrantsRoute(makeRequest(params, {actions: {writeNotes: true}}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(setAgentGrants).not.toHaveBeenCalled();
	});

	test("refuses turning on an action the connection's sign-in didn't cover, but not turning it off", async () => {
		const credential = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes: ['openid'], email: 'alex@example.com'};
		getConnectionWithCredential.mockResolvedValue(
			Ok({
				id: 'conn-1',
				integrationId: 'google',
				orgId: 'org-1',
				ownerUserId: 'user-1',
				connectedById: 'user-1',
				account: 'alex@example.com',
				createdAt: new Date(),
				defaults: [],
				credential: `enc:${JSON.stringify(credential)}`,
			}),
		);

		const {handleSetAgentGrantsRoute} = await import('./route');
		const on = await handleSetAgentGrantsRoute(makeRequest(params, {actions: {readFiles: true}}));
		expect(on.unwrapErr()).toMatchObject({kind: 'validation_error', message: "Google didn't allow Read files at sign-in. Sign in to Google again to allow it."});
		expect(setAgentGrants).not.toHaveBeenCalled();

		const off = await handleSetAgentGrantsRoute(makeRequest(params, {actions: {readFiles: false}}));
		expect(off.isOk()).toBe(true);
		expect(setAgentGrants).toHaveBeenCalledWith({agentId: 'agent-1', connectionId: 'conn-1', actions: {readFiles: false}});
	});

	test('refuses a connection outside the organization', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(null));

		const {handleSetAgentGrantsRoute} = await import('./route');
		const result = await handleSetAgentGrantsRoute(makeRequest(params, {actions: {read: true}}));

		expect(result.unwrapErr().kind).toBe('not_found');
		expect(setAgentGrants).not.toHaveBeenCalled();
	});
});
