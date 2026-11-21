import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const vault = (id: string, name: string | null, actions: string[]) => ({id, integrationId: 'vault', account: 'Acme', shared: false, actions, name, signInNeeded: false});

const listAgentConnections = mock();
mock.module('../../agent-side/tools', () => ({listAgentConnections}));

const held: Record<string, Array<{name: string; value: string}>> = {
	'vault-1': [
		{name: 'API_KEY', value: 'sk-one'},
		{name: 'DB_URL', value: 'postgres://db'},
	],
	'vault-2': [{name: 'WORK_TOKEN', value: 'tok-two'}],
	'vault-3': [{name: 'HIDDEN', value: 'never-used'}],
};
const listSecrets = mock(async (id: string) => Ok(held[id] ?? []));
mock.module('../vault/connector', () => ({listSecrets}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'org-1', experiments: []};
const caller = {agent: signedIn, via: 'mcp' as const, taskId: 'task-1'};

beforeEach(() => {
	mock.clearAllMocks();
	listAgentConnections.mockResolvedValue(
		Ok({
			agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'},
			connections: [vault('vault-1', null, ['readEntries', 'useSecrets']), vault('vault-2', 'Work', ['readEntries', 'useSecrets']), vault('vault-3', 'Other', ['readEntries'])],
		}),
	);
});

describe('secretsFor', () => {
	test('gives the command those asked for, and masks every secret of each vault the agent may use the secrets of', async () => {
		const {secretsFor} = await import('./secrets');
		const {given, masked} = (await secretsFor(caller, ['API_KEY'])).unwrap();

		expect(given).toEqual([{name: 'API_KEY', value: 'sk-one'}]);
		expect(masked.map((secret) => secret.name).sort()).toEqual(['API_KEY', 'DB_URL', 'WORK_TOKEN']);
		expect(listSecrets).not.toHaveBeenCalledWith('vault-3');
	});

	test('asked for none, gives none and still masks them', async () => {
		const {secretsFor} = await import('./secrets');
		const {given, masked} = (await secretsFor(caller, [])).unwrap();

		expect(given).toEqual([]);
		expect(masked).toHaveLength(3);
	});

	test('with no vault whose secrets it may use, a command asking for none runs as it is, and one asking for some is refused', async () => {
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [vault('vault-3', 'Other', ['readEntries'])]}));
		const {secretsFor} = await import('./secrets');

		expect((await secretsFor(caller, [])).unwrap()).toEqual({given: [], masked: []});
		expect((await secretsFor(caller, ['API_KEY'])).unwrapErr().kind).toBe('validation_error');
		expect(listSecrets).not.toHaveBeenCalled();
	});
});
