import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {PapBundle} from '@proxy/cli/build';

import type {SandboxCommand, SandboxOutput} from '@proxy/backends/sandbox/backend';

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
	papVersion: null as string | null,
	createdAt: new Date('2026-11-10T10:00:00Z'),
};

const getSandbox = mock(async () => Ok(sandbox));
const touchSandbox = mock(async () => Ok(undefined));
const setSandboxPapVersion = mock(async () => Ok(undefined));

mock.module('@proxy/db/sandbox', () => ({getSandbox, touchSandbox, setSandboxPapVersion, getHoldingTask: mock(), holdSandbox: mock()}));

const bundle = {code: '#!/usr/bin/env node\nconsole.log("pap")\n', version: 'v2'};
const papBundle = mock(async (): Promise<Result<PapBundle, ApiError>> => Ok(bundle));

mock.module('../../cli/bundle', () => ({papBundle}));

const done: SandboxOutput = {stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false};
const exec = mock(async (_ref: string, _command: SandboxCommand): Promise<Result<SandboxOutput, ApiError>> => Ok(done));
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
	sandbox.papVersion = 'v2';
	exec.mockImplementation(async () => Ok(done));
	mockEnv.AUTH_SECRET = 'test-auth-secret';
	mockEnv.APP_URL = 'https://app.example.com';
});

describe('runSandboxCommand', () => {
	test('with pap, the command is given PAP_URL and a PAP_TOKEN for the agent, its task and the sandbox', async () => {
		const result = await run({pap: true, timeout: 60});

		expect(result.unwrap()).toContain('Exit code: 0');
		const env = exec.mock.calls.at(-1)?.[1].env ?? {};
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

// The commands the backend was sent, in order.
function sent(): SandboxCommand[] {
	return exec.mock.calls.map(([, command]) => command);
}

describe('pap in the sandbox', () => {
	test('first used where none was installed: installed from stdin, recorded, then the command, with pap on its PATH', async () => {
		sandbox.papVersion = null;
		const params = {sandbox: 'sandbox-1', command: 'pap connections | jq length', pap: true, cwd: 'work', timeout: 90};

		const {runSandboxCommand} = await import('./exec');
		const result = await runSandboxCommand({caller, connection, params});

		expect(result.unwrap()).toBe('Exit code: 0\n\nstdout:\nhi\n');
		const [install, command] = sent();
		expect(install).toEqual({command: expect.stringContaining('mv -f "$tmp" "$dir/pap"'), stdin: bundle.code, timeoutMs: 20_000});
		expect(install?.command).toContain('$HOME/.local/bin');
		expect(setSandboxPapVersion).toHaveBeenCalledWith('sandbox-1', 'v2');
		expect(command).toMatchObject({command: 'export PATH="$HOME/.local/bin:$PATH"\npap connections | jq length', cwd: 'work', timeoutMs: 90_000});
		expect(Object.keys(command?.env ?? {}).sort()).toEqual(['PAP_TOKEN', 'PAP_URL']);
		// What the gate logs is the params as the agent gave them.
		expect(params.command).toBe('pap connections | jq length');
	});

	test('installed already at this version: not installed again', async () => {
		await run({pap: true});

		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.command).toStartWith('export PATH=');
		expect(setSandboxPapVersion).not.toHaveBeenCalled();
	});

	test('another version installed: installed again', async () => {
		sandbox.papVersion = 'v1';
		await run({pap: true});

		expect(sent()).toHaveLength(2);
		expect(sent()[0]?.stdin).toBe(bundle.code);
		expect(setSandboxPapVersion).toHaveBeenCalledWith('sandbox-1', 'v2');
	});

	test('an install that fails fails the call, the command not run and nothing recorded', async () => {
		sandbox.papVersion = null;
		exec.mockImplementationOnce(async () => Ok({stdout: '', stderr: 'mkdir: cannot create directory: Read-only file system\n', exitCode: 1, timedOut: false}));
		const failed = await run({pap: true});
		exec.mockImplementationOnce(async () => Ok({stdout: '', stderr: '', exitCode: null, timedOut: true}));
		const slow = await run({pap: true});
		exec.mockImplementationOnce(async () => Err(ApiErr.conflict('The sandbox is asleep.')));
		const refused = await run({pap: true});

		expect(failed.unwrapErr()).toMatchObject({
			kind: 'unavailable',
			message: expect.stringContaining('pap could not be installed in the sandbox (mkdir: cannot create directory: Read-only file system)'),
		});
		expect(slow.unwrapErr()).toMatchObject({message: expect.stringContaining('(it took too long)')});
		expect(refused.unwrapErr().kind).toBe('conflict');
		expect(sent()).toHaveLength(3);
		expect(sent().every((command) => command.stdin === bundle.code && command.env === undefined)).toBe(true);
		expect(setSandboxPapVersion).not.toHaveBeenCalled();
	});

	test('pap that can’t be built fails the call before the sandbox is touched', async () => {
		papBundle.mockImplementationOnce(async () => Err(ApiErr.unavailable('pap could not be installed: this server could not build it.')));
		const result = await run({pap: true});

		expect(result.unwrapErr().kind).toBe('unavailable');
		expect(wakeSandbox).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});

	test('without pap: nothing built or installed, and the command as it was given', async () => {
		sandbox.papVersion = null;
		await run({});

		expect(papBundle).not.toHaveBeenCalled();
		expect(sent()).toEqual([{command: 'echo hi', stdin: undefined, cwd: undefined, timeoutMs: 60_000}]);
		expect(setSandboxPapVersion).not.toHaveBeenCalled();
	});
});
