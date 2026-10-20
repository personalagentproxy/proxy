import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {TokenRefresher} from './token-session';

const updateConnectionCredential = mock();
const getConnectionCredential = mock();

mock.module('@proxy/db/connection', () => ({getConnectionCredential, updateConnectionCredential}));

const warn = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn, error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const credentialSchema = z.object({accessToken: z.string(), expiring: z.boolean()});

type Credential = z.infer<typeof credentialSchema>;

const refresh = mock<(credential: Credential) => Promise<Result<Credential, ApiError>>>();

const REFRESHER: TokenRefresher<Credential> = {name: 'Example', schema: credentialSchema, isExpiring: (credential) => credential.expiring, refresh};

const call = mock<(credential: Credential) => Promise<Result<string, ApiError>>>();

const fresh: Credential = {accessToken: 'access-2', expiring: false};

function connectionWith(expiring: boolean) {
	return {id: 'conn-1', credential: `enc:${JSON.stringify({accessToken: 'access-1', expiring})}`};
}

function tokensCalledWith(): string[] {
	return call.mock.calls.map(([credential]) => credential.accessToken);
}

beforeEach(() => {
	mock.clearAllMocks();
	refresh.mockResolvedValue(Ok(fresh));
	updateConnectionCredential.mockResolvedValue(Ok(true));
	getConnectionCredential.mockResolvedValue(Ok(null));
	call.mockResolvedValue(Ok('answer'));
});

describe('callWithToken', () => {
	test('calls with the stored credential while it lasts', async () => {
		const {callWithToken} = await import('./token-session');
		const text = (await callWithToken(REFRESHER, connectionWith(false), call)).unwrap();

		expect(text).toBe('answer');
		expect(tokensCalledWith()).toEqual(['access-1']);
		expect(refresh).not.toHaveBeenCalled();
		expect(updateConnectionCredential).not.toHaveBeenCalled();
	});

	test('refreshes a credential about to run out, and saves the new one only over the old', async () => {
		const {callWithToken} = await import('./token-session');
		const connection = connectionWith(true);
		await callWithToken(REFRESHER, connection, call);

		expect(tokensCalledWith()).toEqual(['access-2']);
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'conn-1', credential: `enc:${JSON.stringify(fresh)}`, previous: connection.credential});
	});

	test('goes on with the new credential when another server saved its own first', async () => {
		updateConnectionCredential.mockResolvedValue(Ok(false));
		const {callWithToken} = await import('./token-session');
		expect((await callWithToken(REFRESHER, connectionWith(true), call)).unwrap()).toBe('answer');

		expect(tokensCalledWith()).toEqual(['access-2']);
		expect(warn).toHaveBeenCalledWith('Example tokens were refreshed twice at once', {connectionId: 'conn-1'});
	});

	test('calls at once on a running-out credential share one refresh', async () => {
		const {callWithToken} = await import('./token-session');
		const connection = connectionWith(true);
		await Promise.all([callWithToken(REFRESHER, connection, call), callWithToken(REFRESHER, connection, call)]);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(updateConnectionCredential).toHaveBeenCalledTimes(1);
		expect(tokensCalledWith()).toEqual(['access-2', 'access-2']);
	});

	test('a second call in the same request uses the tokens the first one saved, without refreshing again', async () => {
		let saved: string | null = null;
		getConnectionCredential.mockImplementation(async () => Ok(saved));
		updateConnectionCredential.mockImplementation(async ({credential}: {credential: string}) => {
			saved = credential;
			return Ok(true);
		});
		const {callWithToken} = await import('./token-session');
		const connection = connectionWith(true);
		await callWithToken(REFRESHER, connection, call);
		await callWithToken(REFRESHER, connection, call);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(tokensCalledWith()).toEqual(['access-2', 'access-2']);
	});

	test('uses the tokens another server saved since, without refreshing', async () => {
		getConnectionCredential.mockResolvedValue(Ok(`enc:${JSON.stringify(fresh)}`));
		const {callWithToken} = await import('./token-session');
		await callWithToken(REFRESHER, connectionWith(true), call);

		expect(refresh).not.toHaveBeenCalled();
		expect(updateConnectionCredential).not.toHaveBeenCalled();
		expect(tokensCalledWith()).toEqual(['access-2']);
	});

	test('refreshes the tokens saved since when they are running out too, saving over them', async () => {
		const saved = `enc:${JSON.stringify({accessToken: 'access-3', expiring: true})}`;
		getConnectionCredential.mockResolvedValue(Ok(saved));
		const {callWithToken} = await import('./token-session');
		await callWithToken(REFRESHER, connectionWith(true), call);

		expect(refresh.mock.calls.map(([credential]) => credential.accessToken)).toEqual(['access-3']);
		expect(updateConnectionCredential).toHaveBeenCalledWith({connectionId: 'conn-1', credential: `enc:${JSON.stringify(fresh)}`, previous: saved});
	});

	test('a refresh turned down goes on with the tokens another server saved meanwhile', async () => {
		getConnectionCredential.mockResolvedValueOnce(Ok(null)).mockResolvedValueOnce(Ok(`enc:${JSON.stringify(fresh)}`));
		refresh.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callWithToken} = await import('./token-session');
		expect((await callWithToken(REFRESHER, connectionWith(true), call)).unwrap()).toBe('answer');

		expect(tokensCalledWith()).toEqual(['access-2']);
	});

	test('refreshes once when the provider turns the credential down, then gives up', async () => {
		call.mockResolvedValueOnce(Err(ApiErr.credentialsRejected()));
		const {callWithToken} = await import('./token-session');
		expect((await callWithToken(REFRESHER, connectionWith(false), call)).unwrap()).toBe('answer');
		expect(tokensCalledWith()).toEqual(['access-1', 'access-2']);
		expect(refresh).toHaveBeenCalledTimes(1);

		mock.clearAllMocks();
		call.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		expect((await callWithToken(REFRESHER, connectionWith(false), call)).unwrapErr().kind).toBe('credentials_rejected');
		expect(tokensCalledWith()).toEqual(['access-1', 'access-2']);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('does not refresh again when a just-refreshed credential is turned down', async () => {
		call.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callWithToken} = await import('./token-session');
		expect((await callWithToken(REFRESHER, connectionWith(true), call)).unwrapErr().kind).toBe('credentials_rejected');

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(tokensCalledWith()).toEqual(['access-2']);
	});

	test('a refresh that fails is the answer, without a call', async () => {
		refresh.mockResolvedValue(Err(ApiErr.credentialsRejected()));
		const {callWithToken} = await import('./token-session');
		const result = await callWithToken(REFRESHER, connectionWith(true), call);

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(call).not.toHaveBeenCalled();
		expect(updateConnectionCredential).not.toHaveBeenCalled();
	});

	test('a connection without a credential has to be signed in to', async () => {
		const {callWithToken} = await import('./token-session');
		const result = await callWithToken(REFRESHER, {id: 'conn-1', credential: null}, call);

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(call).not.toHaveBeenCalled();
	});
});
