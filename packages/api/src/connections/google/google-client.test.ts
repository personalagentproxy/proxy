import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError, FetchError} from '@proxy/utils';

const updateConnectionCredential = mock();

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential, getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

// Readable stand-ins for encryption, so a test can see what was stored.
mock.module('../../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

// Google's token endpoint and Drive: each request, and the answers given in turn.
const google = {requests: [] as Array<{url: URL; headers: Headers; body: string}>, answers: [] as Response[]};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	google.requests.push({url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : ''});
	return google.answers.shift() ?? Response.json({});
}) as typeof fetch);

function httpError(status: number, error: object): FetchError {
	return {kind: 'http', url: 'https://www.googleapis.com/drive/v3/files', status, body: {error}};
}

const CREDENTIAL = {
	accessToken: 'access-old',
	refreshToken: 'refresh-1',
	expiresAt: new Date(Date.now() - 1000).toISOString(),
	scopes: ['openid', 'https://www.googleapis.com/auth/drive'],
	email: 'alex@example.com',
};

beforeEach(() => {
	mock.clearAllMocks();
	google.requests = [];
	google.answers = [];
	updateConnectionCredential.mockResolvedValue(Ok(true));
});

describe('googleError', () => {
	test('a token turned down is to be refreshed, a missing file not found, and Google busy or down out of reach', async () => {
		const {googleError} = await import('./google-client');

		expect(googleError(httpError(401, {code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED'})).kind).toBe('credentials_rejected');
		expect(googleError(httpError(404, {code: 404, message: 'File not found: abc.', errors: [{reason: 'notFound'}]})).kind).toBe('not_found');
		expect(googleError(httpError(429, {code: 429, message: 'Quota exceeded'})).kind).toBe('provider_unreachable');
		expect(googleError(httpError(503, {code: 503, message: 'The service is currently unavailable.'})).kind).toBe('provider_unreachable');
		expect(googleError(httpError(403, {code: 403, message: 'User rate limit exceeded.', errors: [{reason: 'userRateLimitExceeded'}]})).kind).toBe('provider_unreachable');
		expect(googleError({kind: 'timeout', url: 'https://www.googleapis.com/drive/v3/files', timeoutMs: 30_000}).kind).toBe('provider_unreachable');
	});

	test("a disabled API passes Google's own message on, naming the API and where to enable it", async () => {
		const {googleError} = await import('./google-client');
		const message =
			'Google Drive API has not been used in project 1234 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1234 then retry.';

		expect(googleError(httpError(403, {code: 403, message, status: 'PERMISSION_DENIED', errors: [{reason: 'accessNotConfigured'}]}))).toEqual({kind: 'validation_error', statusCode: 400, message});
		expect(googleError(httpError(403, {code: 403, message, status: 'PERMISSION_DENIED', details: [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED'}]}))).toEqual({
			kind: 'validation_error',
			statusCode: 400,
			message,
		});
	});

	test('a file too large to export says so', async () => {
		const {googleError} = await import('./google-client');

		expect(googleError(httpError(403, {code: 403, message: 'This file is too large to be exported.', errors: [{reason: 'exportSizeLimitExceeded'}]}))).toEqual({
			kind: 'validation_error',
			statusCode: 400,
			message: 'This file is too large to read; Google exports at most 10 MB',
		});
	});

	test('a token without the scope a call takes says to sign in again', async () => {
		const {googleError} = await import('./google-client');

		expect(googleError(httpError(403, {code: 403, message: 'Request had insufficient authentication scopes.', errors: [{reason: 'insufficientPermissions'}]}))).toMatchObject({
			kind: 'validation_error',
			message: "Google didn't allow this at sign-in. Sign in to Google again to allow it.",
		});
	});

	test("any other refusal is passed on in Google's words", async () => {
		const {googleError} = await import('./google-client');

		expect(googleError(httpError(400, {code: 400, message: 'Invalid Value', errors: [{reason: 'invalid'}]}))).toMatchObject({kind: 'validation_error', message: 'Google: Invalid Value'});
	});
});

describe('callGoogle', () => {
	test('refreshes a running-out token with the client secret, keeping the refresh token Google does not send again', async () => {
		const {callGoogle} = await import('./google-client');
		google.answers = [Response.json({access_token: 'access-new', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/drive', token_type: 'Bearer'})];
		const connection = {id: 'google-1', credential: `enc:${JSON.stringify(CREDENTIAL)}`};

		const token = (await callGoogle(connection, async (accessToken) => Ok(accessToken))).unwrap();

		expect(token).toBe('access-new');
		const [refresh] = google.requests;
		expect(refresh?.url.href).toBe('https://oauth2.googleapis.com/token');
		expect(Object.fromEntries(new URLSearchParams(refresh?.body))).toEqual({grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1', client_secret: 'secret-1'});
		const saved = updateConnectionCredential.mock.calls[0]?.[0];
		expect(saved).toMatchObject({connectionId: 'google-1', previous: connection.credential});
		expect(JSON.parse(String(saved.credential).replace(/^enc:/, ''))).toMatchObject({accessToken: 'access-new', refreshToken: 'refresh-1', scopes: CREDENTIAL.scopes, email: 'alex@example.com'});
	});

	test('a refresh Google turns down is a sign-in to make again', async () => {
		const {callGoogle} = await import('./google-client');
		google.answers = [Response.json({error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}, {status: 400})];
		const connection = {id: 'google-1', credential: `enc:${JSON.stringify(CREDENTIAL)}`};

		const result = await callGoogle(connection, async (accessToken) => Ok(accessToken));

		expect(result.isErr() && result.error.kind).toBe('credentials_rejected');
		expect(updateConnectionCredential).not.toHaveBeenCalled();
	});

	test('sends the token as a bearer and reads the answer', async () => {
		const {googleRequest} = await import('./google-client');
		google.answers = [Response.json({id: 'root-id'})];

		const answer = await googleRequest('access-1', new URL('https://www.googleapis.com/drive/v3/files/root?fields=id'), z.object({id: z.string()}));

		expect(answer.unwrap()).toEqual({id: 'root-id'});
		expect(google.requests[0]?.headers.get('authorization')).toBe('Bearer access-1');
	});
});
