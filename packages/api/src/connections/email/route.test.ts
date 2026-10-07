import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const listConnections = mock();
const createConnection = mock();

mock.module('@proxy/db/connection', () => ({listConnections, createConnection}));

const getUserOrgId = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));

const checkMailbox = mock();

mock.module('./mail-check', () => ({checkMailbox}));

const encryptSecret = mock((plaintext: string): Result<string, ApiError> => Ok(`encrypted:${plaintext}`));

mock.module('../../utils/secret-crypto', () => ({encryptSecret}));

const createdRow = {
	id: 'conn-1',
	integrationId: 'email',
	account: 'alex@gmail.com',
	createdAt: new Date('2026-10-01T00:00:00Z'),
	defaults: [],
};

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1', email: 'alex@gmail.com'}, params: {}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listConnections.mockResolvedValue(Ok([]));
	createConnection.mockResolvedValue(Ok(createdRow));
	checkMailbox.mockResolvedValue(Ok(undefined));
});

describe('handleConnectEmailRoute', () => {
	test("signs in with the provider's servers, then stores the encrypted credential", async () => {
		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(makeRequest({provider: 'gmail', email: ' Alex@Gmail.com ', password: 'abcd efgh ijkl mnop'}));

		const credential = {imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, username: 'alex@gmail.com', password: 'abcdefghijklmnop'};
		expect(checkMailbox).toHaveBeenCalledWith(credential);
		expect(createConnection).toHaveBeenCalledWith({
			orgId: 'org-1',
			integrationId: 'email',
			account: 'alex@gmail.com',
			credential: `encrypted:${JSON.stringify(credential)}`,
		});
		const connection = result.unwrap();
		expect(connection.id).toBe('conn-1');
		expect(connection.collections).toEqual([
			{id: 'emails', defaults: []},
			{id: 'drafts', defaults: []},
		]);
	});

	test('takes typed-in servers for another provider, and its password as typed', async () => {
		const {handleConnectEmailRoute} = await import('./route');
		await handleConnectEmailRoute(
			makeRequest({provider: 'other', email: 'alex@example.com', password: 'pass word', servers: {imapHost: 'Mail.Example.com', smtpHost: 'mail.example.com', smtpPort: 587}}),
		);

		expect(checkMailbox).toHaveBeenCalledWith({imapHost: 'mail.example.com', smtpHost: 'mail.example.com', smtpPort: 587, username: 'alex@example.com', password: 'pass word'});
	});

	test('another provider needs its servers', async () => {
		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(makeRequest({provider: 'other', email: 'alex@example.com', password: 'secret'}));

		expect(result.unwrapErr().kind).toBe('validation_error');
		expect(checkMailbox).not.toHaveBeenCalled();
	});

	test('refuses ports other than the mail ports', async () => {
		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(
			makeRequest({provider: 'other', email: 'alex@example.com', password: 'secret', servers: {imapHost: 'mail.example.com', smtpHost: 'mail.example.com', smtpPort: 5432}}),
		);

		expect(result.unwrapErr().kind).toBe('parse_error');
	});

	test('refuses a mailbox that is already connected', async () => {
		listConnections.mockResolvedValue(Ok([{...createdRow, id: 'conn-0'}]));

		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(makeRequest({provider: 'gmail', email: 'alex@gmail.com', password: 'secret'}));

		expect(result.unwrapErr().kind).toBe('conflict');
		expect(checkMailbox).not.toHaveBeenCalled();
	});

	test('saves nothing when the mailbox turns the password down', async () => {
		checkMailbox.mockResolvedValue(Err(ApiErr.credentialsRejected()));

		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(makeRequest({provider: 'gmail', email: 'alex@gmail.com', password: 'wrong'}));

		expect(result.unwrapErr().kind).toBe('credentials_rejected');
		expect(createConnection).not.toHaveBeenCalled();
	});

	test('saves nothing without an encryption key', async () => {
		encryptSecret.mockReturnValueOnce(Err(ApiErr.internalError(new Error('ENCRYPTION_KEY is not set'))));

		const {handleConnectEmailRoute} = await import('./route');
		const result = await handleConnectEmailRoute(makeRequest({provider: 'gmail', email: 'alex@gmail.com', password: 'secret'}));

		expect(result.unwrapErr().kind).toBe('internal_error');
		expect(checkMailbox).not.toHaveBeenCalled();
		expect(createConnection).not.toHaveBeenCalled();
	});
});
