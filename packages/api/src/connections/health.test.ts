import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {ApiIntegration, StoredConnection} from './integration';

const check = mock(async (_connection: StoredConnection): Promise<Result<void, ApiError>> => Ok(undefined));
const integration: ApiIntegration = {id: 'mcp', connectors: {}, check};
const apiIntegration = mock((_id: string): ApiIntegration | undefined => integration);
const viewer = {orgId: 'org-1', userId: 'user-1', role: 'owner' as const};
const requireViewer = mock(async () => Ok(viewer));
const connection = {id: 'connection-1', integrationId: 'mcp', credential: 'encrypted-fixture'};
const requireConnection = mock(async (): Promise<Result<StoredConnection, ApiError>> => Ok(connection));
const updateConnectionHealth = mock(async () => Ok(undefined));

mock.module('@proxy/db/connection', () => ({updateConnectionHealth}));
mock.module('./integrations', () => ({apiIntegration}));
mock.module('./managed', () => ({requireConnection}));
mock.module('../utils/user-org', () => ({requireViewer}));

const {checkConnection, handleCheckConnectionRoute} = await import('./health');

beforeEach(() => {
	check.mockClear();
	check.mockResolvedValue(Ok(undefined));
	apiIntegration.mockReturnValue(integration);
	requireConnection.mockClear();
	requireConnection.mockResolvedValue(Ok(connection));
	updateConnectionHealth.mockClear();
	updateConnectionHealth.mockResolvedValue(Ok(undefined));
});

describe('connection health', () => {
	test('saved credentials rejected by the provider need sign-in, not a healthy badge', async () => {
		check.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const result = await checkConnection(connection);
		expect(result.status).toBe('sign_in_required');
		expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
		expect(check).toHaveBeenCalledWith(connection);
	});

	test('a successful live probe is healthy', async () => {
		expect((await checkConnection(connection)).status).toBe('healthy');
		expect(check).toHaveBeenCalledTimes(1);
	});

	test('a connection without credentials is not probed', async () => {
		expect((await checkConnection({...connection, credential: null})).status).toBe('sign_in_required');
		expect(check).not.toHaveBeenCalled();
	});

	test('an unsupported provider is never declared healthy', async () => {
		apiIntegration.mockReturnValue({id: 'email', connectors: {}});
		expect((await checkConnection({...connection, integrationId: 'email'})).status).toBe('unsupported');
		expect(check).not.toHaveBeenCalled();
	});

	test('an unreachable provider does not leak its response or credential', async () => {
		check.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('fixture-secret'), 'fixture-secret')));
		const result = await checkConnection(connection);
		expect(result.status).toBe('unreachable');
		expect(JSON.stringify(result)).not.toContain('fixture-secret');
		expect(JSON.stringify(result)).not.toContain(connection.credential);
	});

	test('an unexpected probe failure is not a success or a leaked error', async () => {
		check.mockRejectedValue(new Error('fixture-secret'));
		const result = await checkConnection(connection);
		expect(result.status).toBe('error');
		expect(JSON.stringify(result)).not.toContain('fixture-secret');
	});

	test('cannot probe a connection outside the viewer’s access', async () => {
		requireConnection.mockResolvedValue(Err(ApiErr.notFound('connection')));
		const request = {params: {connectionId: 'private-connection'}} as never;
		const result = await handleCheckConnectionRoute(request);
		expect(result.isErr() && result.error.kind).toBe('not_found');
		expect(requireConnection).toHaveBeenCalledWith(viewer, 'private-connection');
		expect(check).not.toHaveBeenCalled();
		expect(updateConnectionHealth).not.toHaveBeenCalled();
	});

	test('stores the check result for the next browser session', async () => {
		const request = {params: {connectionId: 'connection-1'}} as never;
		const result = await handleCheckConnectionRoute(request);
		expect(result.isOk()).toBe(true);
		expect(updateConnectionHealth).toHaveBeenCalledWith('connection-1', expect.objectContaining({status: 'healthy'}));
	});
});
