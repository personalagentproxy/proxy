import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listIntegrationCredentials = mock();
const rewriteConnectionCredential = mock();
mock.module('@proxy/db/connection', () => ({listIntegrationCredentials, rewriteConnectionCredential}));

const error = mock();
mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error},
	serializeError: mock(() => ({})),
}));

// Readable stand-ins for encryption; one stored as "garbled" can't be decrypted.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => (stored === 'garbled' ? Err(ApiErr.internalError(new Error('bad key'))) : Ok(stored.replace(/^enc:/, ''))),
}));

mock.module('../built-in-mcp', () => ({builtInMcps: () => [{integrationId: 'notion'}, {integrationId: 'exa'}]}));

const {unifyMcpCredentials} = await import('./unify-credentials');

const tokens = {clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null};
const stored = (credential: object) => `enc:${JSON.stringify(credential)}`;

beforeEach(() => {
	mock.clearAllMocks();
	rewriteConnectionCredential.mockResolvedValue(Ok(true));
});

describe('unifyMcpCredentials', () => {
	test('rewrites a key and bare tokens in the shape they have now, each only over the one read, and leaves one in it already', async () => {
		listIntegrationCredentials.mockResolvedValue(
			Ok([
				{id: 'exa-1', credential: stored({auth: 'key', key: 'exa-key-1'})},
				{id: 'notion-1', credential: stored(tokens)},
				{id: 'notion-2', credential: stored({auth: 'oauth', ...tokens})},
			]),
		);

		expect((await unifyMcpCredentials()).isOk()).toBe(true);

		expect(listIntegrationCredentials).toHaveBeenCalledWith(['notion', 'exa']);
		expect(rewriteConnectionCredential.mock.calls.map((call) => call[0])).toEqual([
			{connectionId: 'exa-1', previous: stored({auth: 'key', key: 'exa-key-1'}), credential: stored({auth: 'token', token: 'exa-key-1'})},
			{connectionId: 'notion-1', previous: stored(tokens), credential: stored({auth: 'oauth', ...tokens})},
		]);
	});

	test('one changed meanwhile, or not saved, is left for the next start, the rest still rewritten', async () => {
		listIntegrationCredentials.mockResolvedValue(
			Ok([
				{id: 'exa-1', credential: stored({auth: 'key', key: 'exa-key-1'})},
				{id: 'exa-2', credential: stored({auth: 'key', key: 'exa-key-2'})},
				{id: 'exa-3', credential: stored({auth: 'key', key: 'exa-key-3'})},
			]),
		);
		rewriteConnectionCredential.mockResolvedValueOnce(Ok(false)).mockResolvedValueOnce(Err(ApiErr.dbError(new Error('down'))));

		expect((await unifyMcpCredentials()).isErr()).toBe(true);
		expect(rewriteConnectionCredential).toHaveBeenCalledTimes(3);
	});

	test('one that can’t be read is logged and passed over, as it was unusable before too', async () => {
		listIntegrationCredentials.mockResolvedValue(
			Ok([
				{id: 'notion-1', credential: 'garbled'},
				{id: 'exa-1', credential: stored({auth: 'key', key: 'exa-key-1'})},
			]),
		);

		expect((await unifyMcpCredentials()).isOk()).toBe(true);
		expect(error).toHaveBeenCalledTimes(1);
		expect(rewriteConnectionCredential).toHaveBeenCalledTimes(1);
	});

	test('listing them failing has the migration tried again', async () => {
		listIntegrationCredentials.mockResolvedValue(Err(ApiErr.dbError(new Error('down'))));
		expect((await unifyMcpCredentials()).isErr()).toBe(true);
		expect(rewriteConnectionCredential).not.toHaveBeenCalled();
	});
});
