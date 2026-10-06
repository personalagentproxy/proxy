import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const listAgents = mock();
const getAgent = mock();
const createAgent = mock();
const updateAgent = mock();
const deleteAgent = mock();
const setAgentGrant = mock();
const isUsernameConflict = mock(() => false);

mock.module('@proxy/db/agent', () => ({listAgents, getAgent, createAgent, updateAgent, deleteAgent, setAgentGrant, isUsernameConflict}));

const getConnection = mock();

mock.module('@proxy/db/connection', () => ({getConnection}));

const requireUserOrgId = mock();

mock.module('../utils/user-org', () => ({requireUserOrgId}));

const agentRow = {
	id: 'agent-1',
	name: 'Inbox assistant',
	username: 'inbox-assistant-k7q2',
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
	setAgentGrant.mockResolvedValue(Ok(undefined));
	getConnection.mockResolvedValue(Ok({id: 'conn-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: []}));
	isUsernameConflict.mockReturnValue(false);
});

describe('handleCreateAgentRoute', () => {
	test('sends the password once and stores only its hash', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {name: ' Inbox assistant '}));

		const {password, agent} = result.unwrap();
		expect(password).toMatch(/^[\w]{5}-[\w]{5}-[\w]{5}-[\w]{5}$/);
		expect(agent.id).toBe('agent-1');

		const data = createAgent.mock.calls[0]?.[0];
		expect(data.name).toBe('Inbox assistant');
		expect(data.username).toMatch(/^inbox-assistant-[a-z0-9]{4}$/);
		expect(data.passwordHash).not.toContain(password);
		expect(await Bun.password.verify(password, data.passwordHash)).toBe(true);
	});

	test('tries another username when one is taken', async () => {
		const conflict = Err(ApiErr.dbError(new Error('P2002')));
		createAgent.mockResolvedValueOnce(conflict);
		isUsernameConflict.mockReturnValueOnce(true);

		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {name: 'Inbox assistant'}));

		expect(result.isOk()).toBe(true);
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	test('needs a name', async () => {
		const {handleCreateAgentRoute} = await import('./route');
		const result = await handleCreateAgentRoute(makeRequest({}, {name: '  '}));

		expect(result.unwrapErr().kind).toBe('parse_error');
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

describe('handleSetAgentGrantRoute', () => {
	const params = {agentId: 'agent-1', connectionId: 'conn-1', collectionId: 'drafts'};

	test("sets the agent's own access", async () => {
		const {handleSetAgentGrantRoute} = await import('./route');
		const result = await handleSetAgentGrantRoute(makeRequest(params, {access: 'write'}));

		expect(setAgentGrant).toHaveBeenCalledWith({agentId: 'agent-1', connectionId: 'conn-1', collectionId: 'drafts', access: 'write'});
		expect(result.isOk()).toBe(true);
	});

	test('null returns the agent to the default', async () => {
		const {handleSetAgentGrantRoute} = await import('./route');
		await handleSetAgentGrantRoute(makeRequest(params, {access: null}));

		expect(setAgentGrant).toHaveBeenCalledWith({agentId: 'agent-1', connectionId: 'conn-1', collectionId: 'drafts', access: null});
	});

	test('refuses access above what the provider allows', async () => {
		const {handleSetAgentGrantRoute} = await import('./route');
		const result = await handleSetAgentGrantRoute(makeRequest({...params, collectionId: 'emails'}, {access: 'write'}));

		expect(result.unwrapErr().kind).toBe('conflict');
		expect(setAgentGrant).not.toHaveBeenCalled();
	});

	test('refuses a connection outside the organization', async () => {
		getConnection.mockResolvedValue(Ok(null));

		const {handleSetAgentGrantRoute} = await import('./route');
		const result = await handleSetAgentGrantRoute(makeRequest(params, {access: 'read'}));

		expect(result.unwrapErr().kind).toBe('not_found');
		expect(setAgentGrant).not.toHaveBeenCalled();
	});
});
