import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {DisconnectedConnection} from './integration';

const countSameAccountConnections = mock();

mock.module('@proxy/db/connection', () => ({countSameAccountConnections}));

const revokeGoogleTokens = mock();

mock.module('./google/google-oauth', () => ({
	readGoogleCredential: (stored: string | null) => Ok({refreshToken: stored}),
	revokeGoogleTokens,
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

// Of the integrations' modules, Google's revoke, undone once for an account, and one undone for
// each connection.
const {REVOKE_GOOGLE} = await import('./google/revoke');
const removeLogin = mock(async (_connection: DisconnectedConnection, _going: string[]) => Ok(undefined));
const integrations = [
	{id: 'google', connectors: {}, revoke: REVOKE_GOOGLE},
	{id: 'plaid', connectors: {}, revoke: {per: 'connection', run: removeLogin}},
];

mock.module('./integrations', () => ({apiIntegration: (id: string) => integrations.find((integration) => integration.id === id)}));

const work = {id: 'conn-1', integrationId: 'google', account: 'dana@example.com', credential: 'enc:1'};
const again = {id: 'conn-2', integrationId: 'google', account: 'dana@example.com', credential: 'enc:2'};
const mailbox = {id: 'conn-3', integrationId: 'email', account: 'dana@example.com', credential: 'enc:3'};
const bank = {id: 'conn-4', integrationId: 'plaid', account: 'First Platypus Bank', credential: 'enc:4'};
const sameBank = {id: 'conn-5', integrationId: 'plaid', account: 'First Platypus Bank', credential: 'enc:5'};

beforeEach(() => {
	mock.clearAllMocks();
	countSameAccountConnections.mockResolvedValue(Ok(0));
	revokeGoogleTokens.mockResolvedValue(Ok(undefined));
});

describe('beforeDisconnect', () => {
	test('keeps the Google grant while another connection, not going too, is for the account', async () => {
		countSameAccountConnections.mockResolvedValue(Ok(1));
		const {beforeDisconnect} = await import('./disconnect');
		await beforeDisconnect(work);

		expect(countSameAccountConnections).toHaveBeenCalledWith('conn-1', ['conn-1']);
		expect(revokeGoogleTokens).not.toHaveBeenCalled();
	});

	test('revokes it when the connection is the last for the account', async () => {
		const {beforeDisconnect} = await import('./disconnect');
		await beforeDisconnect(work);

		expect(revokeGoogleTokens).toHaveBeenCalledWith({refreshToken: 'enc:1'});
	});
});

describe('beforeDisconnectAll', () => {
	test('counts none of the connections going together, and revokes an account among them once', async () => {
		const {beforeDisconnectAll} = await import('./disconnect');
		await beforeDisconnectAll([work, again, mailbox]);

		expect(countSameAccountConnections).toHaveBeenCalledTimes(1);
		expect(countSameAccountConnections).toHaveBeenCalledWith('conn-1', ['conn-1', 'conn-2', 'conn-3']);
		expect(revokeGoogleTokens).toHaveBeenCalledTimes(1);
	});

	test('undoes what is undone for each connection for each of them, the same bank twice included', async () => {
		const {beforeDisconnectAll} = await import('./disconnect');
		await beforeDisconnectAll([bank, sameBank, mailbox]);

		expect(removeLogin.mock.calls).toEqual([
			[bank, ['conn-4', 'conn-5', 'conn-3']],
			[sameBank, ['conn-4', 'conn-5', 'conn-3']],
		]);
	});
});
