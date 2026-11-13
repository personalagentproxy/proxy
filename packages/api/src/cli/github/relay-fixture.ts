import {mock} from 'bun:test';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';

import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import * as realAgent from '@proxy/db/agent';
import * as realAudit from '@proxy/db/audit';
import * as realConnection from '@proxy/db/connection';
import * as realSandbox from '@proxy/db/sandbox';

import * as realTasks from '../../agent-side/tasks';
import {signCliToken} from '../token';

/**
 * The whole app, as the api serves it, for the GitHub relay's tests (route.test.ts,
 * real-git.test.ts), with the database's answers made here: an agent, its task and sandbox, and
 * its connections, whose credentials are stored as readable JSON. Each test file imports this
 * first, so its mocks are in place before the app is.
 */

export const SECRET = 'test-auth-secret';
export const APP_URL = 'https://app.example.com';
/** The GitHub token every connection here holds, which must never come back. */
export const GITHUB_TOKEN = 'ghu_relay-test-token';

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL, AUTH_SECRET: SECRET}}));

export const getSignedInAgentById = mock();
export const getAgentById = mock();

mock.module('@proxy/db/agent', () => ({...realAgent, getSignedInAgentById, getAgentById}));

export const getSandbox = mock();
export const getHoldingTask = mock();

mock.module('@proxy/db/sandbox', () => ({...realSandbox, getSandbox, getHoldingTask}));

export const requireOpenTask = mock();

mock.module('../../agent-side/tasks', () => ({...realTasks, requireOpenTask}));

export const listConnectionsWithCredential = mock();
export const getConnectionWithCredential = mock();

mock.module('@proxy/db/connection', () => ({...realConnection, listConnectionsWithCredential, getConnectionWithCredential}));

export const logAgentRequest = mock(async (_entry: Parameters<typeof realAudit.logAgentRequest>[0]): Promise<Result<void, ApiError>> => Ok(undefined));

mock.module('@proxy/db/audit', () => ({...realAudit, logAgentRequest}));

// Readable stand-ins for encryption, so a connection's credential is the JSON written here.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

export const serverLog = {debug: mock(), info: mock(), warn: mock(), error: mock()};

mock.module('../../observability/log', () => ({log: serverLog, serializeError: mock(() => ({}))}));

export const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'org-1', experiments: []};

const sandbox = {
	id: 'sandbox-1',
	orgId: 'org-1',
	connectionId: 'sandboxes-1',
	name: 'scratch',
	state: 'running',
	backendId: 'temp-dir',
	backendRef: 'ref-1',
	heldByTaskId: 'task-1',
	heldAt: new Date(),
	lastUsedAt: new Date(),
	createdAt: new Date(),
};

/** The agent, with its own settings: `grants` by connection and action. */
export function agentRow(grants: Array<{connectionId: string; actionId: string; allowed: boolean}> = []) {
	return {
		id: 'agent-1',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		createdById: 'user-1',
		providerId: 'claude',
		name: 'Claude',
		username: 'claude',
		createdAt: new Date(),
		lastActiveAt: null,
		revokedAt: null,
		grants,
	};
}

/** A GitHub connection of `account`, its defaults `defaults`, holding GITHUB_TOKEN. */
export function githubConnection(id: string, account: string, defaults: string[] = ['read'], integrationId = 'github') {
	const credential = {
		accessToken: GITHUB_TOKEN,
		refreshToken: 'ghr_refresh',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		id: '1234',
		login: account,
		name: account === 'octo-dana' ? 'Dana Octo' : null,
	};
	return {
		id,
		orgId: 'org-1',
		integrationId,
		account,
		ownerUserId: 'user-1',
		sharedWithEveryone: false,
		shares: [],
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: defaults.map((actionId) => ({actionId})),
		credentialRejectedAt: null,
		credential: `enc:${JSON.stringify(credential)}`,
	};
}

/** The token a sandbox command was given, for the agent's task. */
export function papToken(): string {
	return signCliToken(
		{agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', taskId: 'task-1', sandboxId: 'sandbox-1', connectionId: 'sandboxes-1', expiresAt: Math.floor(Date.now() / 1000) + 120},
		SECRET,
	);
}

/** The agent with `connections`, every one reached; `grants` its own settings. */
export function useConnections(connections: Array<ReturnType<typeof githubConnection>>, grants: Parameters<typeof agentRow>[0] = []): void {
	getAgentById.mockResolvedValue(Ok(agentRow(grants)));
	listConnectionsWithCredential.mockResolvedValue(Ok(connections));
	getConnectionWithCredential.mockImplementation(async (_viewer: object, id: string) => Ok(connections.find((connection) => connection.id === id) ?? null));
}

/** The defaults: a signed-in agent, its task under way, its sandbox held, the log written. */
export function resetFixture(): void {
	mock.clearAllMocks();
	getSignedInAgentById.mockResolvedValue(Ok(signedIn));
	requireOpenTask.mockResolvedValue(Ok({id: 'task-1'}));
	getSandbox.mockResolvedValue(Ok(sandbox));
	getHoldingTask.mockImplementation(async (_orgId: string, id: string) => Ok({id, parentId: null, title: `Task ${id}`, lastActiveAt: new Date(), finishedAt: null}));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	useConnections([githubConnection('github-1', 'octo-dana')]);
}

/** The app listening on a port of its own; `close` stops it. */
export async function startApp(): Promise<{base: string; server: Server}> {
	const {createHttpApp} = await import('../../server/create-http-app');
	const server = createHttpApp({webDist: '/nonexistent'}).listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	return {base: `http://localhost:${(server.address() as AddressInfo).port}`, server};
}
