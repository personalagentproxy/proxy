import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {SandboxCommand} from '@proxy/backends/sandbox/backend';

import {verifyCliToken} from '../../cli/token';

const mockEnv: {AUTH_SECRET?: string; APP_URL?: string} = {};

mock.module('../../utils/env', () => ({env: mockEnv}));

const sandbox = {
	id: 'sandbox-1',
	orgId: 'org-1',
	connectionId: 'sandboxes-1',
	name: 'scratch',
	state: 'running' as const,
	backendId: 'temp-dir',
	backendRef: 'ref-1',
	heldByTaskId: 'task-1',
	heldAt: new Date('2026-11-10T11:00:00Z'),
	lastUsedAt: new Date('2026-11-10T11:00:00Z'),
	createdAt: new Date('2026-11-10T10:00:00Z'),
};

const getSandbox = mock(async () => Ok(sandbox));
const touchSandbox = mock(async () => Ok(undefined));

mock.module('@proxy/db/sandbox', () => ({getSandbox, touchSandbox, getHoldingTask: mock(), holdSandbox: mock()}));

const exec = mock(async (_ref: string, _command: SandboxCommand) => Ok({stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false}));
const requireBackend = mock(async () => Ok({id: 'temp-dir', exec}));
const wakeSandbox = mock(async () => Ok(sandbox));

mock.module('./machines', () => ({requireBackend, wakeSandbox}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'org-1', experiments: []};
const caller = {agent: signedIn, via: 'mcp' as const, taskId: 'task-1'};
const connection = {id: 'sandboxes-1'} as never;

async function run(params: Record<string, unknown>) {
	const {runSandboxCommand} = await import('./exec');
	return runSandboxCommand({caller, connection, params: {sandbox: 'sandbox-1', command: 'echo hi', ...params}});
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.AUTH_SECRET = 'test-auth-secret';
	mockEnv.APP_URL = 'https://app.example.com';
});

describe('runSandboxCommand', () => {
	test('with pap, the command is given PAP_URL and a PAP_TOKEN for the agent, its task and the sandbox', async () => {
		const result = await run({pap: true, timeout: 60});

		expect(result.unwrap()).toContain('Exit code: 0');
		const env = exec.mock.calls[0]?.[1].env ?? {};
		expect(Object.keys(env).sort()).toEqual(['PAP_TOKEN', 'PAP_URL']);
		expect(env.PAP_URL).toBe('https://app.example.com');
		const claims = verifyCliToken(env.PAP_TOKEN ?? '', 'test-auth-secret').unwrap();
		expect(claims).toMatchObject({agentId: 'agent-1', orgId: 'org-1', taskId: 'task-1', sandboxId: 'sandbox-1', connectionId: 'sandboxes-1'});
		// The command's timeout, and 30 seconds more.
		const left = claims.expiresAt - Date.now() / 1000;
		expect(left).toBeGreaterThan(85);
		expect(left).toBeLessThanOrEqual(91);
	});

	test('without pap, no environment at all', async () => {
		await run({});
		await run({pap: false});

		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls.map(([, command]) => 'env' in command)).toEqual([false, false]);
	});

	test('with pap on a server without AUTH_SECRET or APP_URL, unavailable, saying which, and nothing run', async () => {
		mockEnv.AUTH_SECRET = undefined;
		const noSecret = await run({pap: true});
		mockEnv.APP_URL = undefined;
		const neither = await run({pap: true});

		expect(noSecret.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('AUTH_SECRET is not set')});
		expect(neither.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('AUTH_SECRET and APP_URL are not set')});
		expect(exec).not.toHaveBeenCalled();
		expect(wakeSandbox).not.toHaveBeenCalled();
	});
});
