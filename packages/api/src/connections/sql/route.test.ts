import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection}));

mock.module('@proxy/db/organization', () => ({getMembership: mock(async () => Ok({role: 'owner'})), listMemberNames: mock(async () => Ok([]))}));

const requireViewer = mock(async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}));

mock.module('../../utils/user-org', () => ({requireViewer, requireOwner: requireViewer}));

const checkDatabase = mock();

mock.module('./sql-client', () => ({checkDatabase}));

const encryptSecret = mock((plaintext: string): Result<string, ApiError> => Ok(`encrypted:${plaintext}`));

mock.module('../../utils/secret-crypto', () => ({encryptSecret, decryptSecret: (stored: string) => Ok(stored)}));

const createdRow = {
	id: 'conn-1',
	integrationId: 'postgres',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	connectedById: 'user-1',
	account: 'reader@db.example.com/app',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	defaults: [{actionId: 'read'}, {actionId: 'query'}],
};

const body = {host: 'db.example.com', port: 5432, database: 'app', username: 'reader', password: 'secret', tls: 'verify'};

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1', email: 'alex@example.com'}, params: {}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok(createdRow));
	checkDatabase.mockResolvedValue(Ok(undefined));
});

describe('sqlConnectRoutes', () => {
	test('signs in first, then stores the encrypted credential with reading on by default', async () => {
		const {sqlConnectRoutes} = await import('./route');
		const result = await sqlConnectRoutes('postgres').handleConnect(makeRequest({...body, host: ' DB.example.com '}));

		const credential = {...body, host: 'DB.example.com'};
		expect(checkDatabase).toHaveBeenCalledWith('postgres', credential);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			ownerUserId: 'user-1',
			connectedById: 'user-1',
			integrationId: 'postgres',
			account: 'reader@DB.example.com/app',
			credential: `encrypted:${JSON.stringify(credential)}`,
			defaults: ['read', 'query'],
		});
		expect(result.unwrap()).toMatchObject({id: 'conn-1', defaults: ['read', 'query']});
	});

	test('connects a MySQL database as its own integration, an IPv6 address without its brackets', async () => {
		const {sqlConnectRoutes} = await import('./route');
		await sqlConnectRoutes('mysql').handleConnect(makeRequest({...body, host: '[2001:db8::7]', port: 3306}));

		expect(checkDatabase).toHaveBeenCalledWith('mysql', {...body, host: '2001:db8::7', port: 3306});
		expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({integrationId: 'mysql', account: 'reader@2001:db8::7/app'}));
	});

	test('saves nothing when the sign-in fails', async () => {
		const {sqlConnectRoutes} = await import('./route');
		checkDatabase.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const result = await sqlConnectRoutes('postgres').handleConnect(makeRequest(body));

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});

	test('the same database as the same user is connected once; as another user it is another connection', async () => {
		const {sqlConnectRoutes} = await import('./route');
		listConnections.mockResolvedValue(Ok([{id: 'conn-0', integrationId: 'postgres', account: 'reader@db.example.com/app', defaults: []}]));

		expect((await sqlConnectRoutes('postgres').handleConnect(makeRequest(body))).unwrapErr().kind).toBe('conflict');
		expect((await sqlConnectRoutes('postgres').handleConnect(makeRequest({...body, username: 'writer'}))).isOk()).toBe(true);
		expect((await sqlConnectRoutes('mysql').handleConnect(makeRequest(body))).isOk()).toBe(true);
	});

	test('refuses a host with a path or spaces, a port out of range and an unknown TLS mode', async () => {
		const {sqlConnectRoutes} = await import('./route');
		const {handleConnect} = sqlConnectRoutes('postgres');
		for (const bad of [{host: 'db.example.com/app'}, {host: 'db example.com'}, {port: 70000}, {port: '5432'}, {tls: 'maybe'}, {database: ''}, {username: ' '}]) {
			expect((await handleConnect(makeRequest({...body, ...bad}))).unwrapErr().statusCode, JSON.stringify(bad)).toBe(400);
		}
		expect(checkDatabase).not.toHaveBeenCalled();
	});

	test('an empty password is taken, as a local database may have none', async () => {
		const {sqlConnectRoutes} = await import('./route');
		expect((await sqlConnectRoutes('postgres').handleTest(makeRequest({...body, password: ''}))).isOk()).toBe(true);
		expect(checkDatabase).toHaveBeenCalledWith('postgres', {...body, password: ''});
	});

	test('testing signs in and saves nothing', async () => {
		const {sqlConnectRoutes} = await import('./route');
		expect((await sqlConnectRoutes('mysql').handleTest(makeRequest(body))).isOk()).toBe(true);
		expect(checkDatabase).toHaveBeenCalledWith('mysql', body);
		expect(createConnection).not.toHaveBeenCalled();

		checkDatabase.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('refused'))));
		expect((await sqlConnectRoutes('mysql').handleTest(makeRequest(body))).unwrapErr().kind).toBe('provider_unreachable');
	});
});
