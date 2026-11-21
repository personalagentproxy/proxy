import {randomUUID} from 'node:crypto';

import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest} from '@proxy/utils';

import {googleOAuthClient, type GoogleClient} from '../../utils/google-oauth-client';
import {callWithToken, type TokenRefresher} from '../token-session';
import {googleCredentialSchema, isExpiring, refreshGoogleTokens, type GoogleCredential} from './google-oauth';

/**
 * Google's REST APIs with a connection's access token: JSON in and out, or text where a file is
 * exported, and Google's errors turned into what they mean for the agent. A disabled API passes
 * Google's own message on, since it names the API and the page enabling it, which is what a
 * self-hoster setting up the Cloud project needs.
 */

const TIMEOUT_MS = 30_000;

type StoredConnection = {id: string; credential: string | null};

const googleErrorSchema = z.object({
	error: z.object({
		message: z.string().optional(),
		// The newer APIs' kind of error, such as FAILED_PRECONDITION.
		status: z.string().optional(),
		errors: z.array(z.object({reason: z.string().optional()})).optional(),
		// Newer APIs say why in `details`, such as SERVICE_DISABLED.
		details: z.array(z.object({reason: z.string().optional()})).optional(),
	}),
});

// The reasons Google gave for an error, from both places it puts them, its kind and its message.
function readGoogleError(error: Extract<FetchError, {kind: 'http'}>): {reasons: string[]; status: string; message: string} {
	const parsed = googleErrorSchema.safeParse(error.body);
	if (!parsed.success) {
		return {reasons: [], status: '', message: ''};
	}
	const {errors = [], details = [], status = '', message = ''} = parsed.data.error;
	const reasons = [...errors, ...details].flatMap((entry) => (entry.reason ? [entry.reason] : []));
	return {reasons, status, message};
}

/** What reading a file past Google's export limit says, where its content would be. */
export const TOO_LARGE_TO_READ = 'This file is too large to read; Google exports at most 10 MB';

const RATE_LIMITED = ['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED'];

// What Google says of a call whose token lacks the scope it takes, as sending a draft does with
// only `gmail.send` granted.
const SCOPE_MISSING = ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'];

/** What one of Google's errors means: a token to refresh, a file not there, a refusal to pass on, or Google out of reach. */
export function googleError(error: FetchError): ApiError {
	if (error.kind !== 'http') {
		return ApiErr.providerUnreachable(error);
	}
	if (error.status === 401) {
		return ApiErr.credentialsRejected();
	}
	if (error.status === 404) {
		return ApiErr.notFound('file');
	}
	if (error.status === 429 || error.status >= 500) {
		return ApiErr.providerUnreachable(error);
	}

	const {reasons, message} = readGoogleError(error);
	if (reasons.includes('exportSizeLimitExceeded')) {
		return ApiErr.validationError(TOO_LARGE_TO_READ);
	}
	if (reasons.includes('accessNotConfigured') || reasons.includes('SERVICE_DISABLED') || /has not been used|is disabled/.test(message)) {
		return ApiErr.validationError(message);
	}
	// Drive says it is busy with a 403.
	if (reasons.some((reason) => RATE_LIMITED.includes(reason))) {
		return ApiErr.providerUnreachable(error);
	}
	if (reasons.some((reason) => SCOPE_MISSING.includes(reason))) {
		return ApiErr.validationError("Google didn't allow this at sign-in. Sign in to Google again to allow it.");
	}
	// Any other refusal, such as a file the account may not open or a query Google can't read, in
	// Google's own words.
	if (message !== '') {
		return ApiErr.validationError(`Google: ${message}`);
	}
	return ApiErr.providerUnreachable(error);
}

function authHeaders(accessToken: string): Record<string, string> {
	return {authorization: `Bearer ${accessToken}`, accept: 'application/json'};
}

function authorized(accessToken: string): RequestInit {
	return {headers: authHeaders(accessToken)};
}

/** A GET to one of Google's APIs, its answer read with `schema`. */
export async function googleRequest<S extends z.ZodType>(accessToken: string, url: URL, schema: S): Promise<Result<z.infer<S>, ApiError>> {
	const answer = await httpRequest(url, authorized(accessToken), {schema, timeoutMs: TIMEOUT_MS});
	return answer.mapErr(googleError);
}

/** A GET whose answer is text, as a file exported is. */
export async function googleText(accessToken: string, url: URL): Promise<Result<string, ApiError>> {
	const answer = await httpRequest(url, authorized(accessToken), {parse: 'text', timeoutMs: TIMEOUT_MS});
	return answer.mapErr(googleError);
}

type WriteMethod = 'POST' | 'PUT' | 'PATCH';

/** A POST, PUT or PATCH to one of Google's APIs with a JSON body, its answer read with `schema`. */
export function googleWrite<S extends z.ZodType>(accessToken: string, method: WriteMethod, url: URL, body: object, schema: S): Promise<Result<z.infer<S>, ApiError>> {
	return googleUpload(accessToken, method, url, {type: 'application/json', body: JSON.stringify(body)}, schema);
}

/**
 * A write made only to the revision of a file the agent read, as a Doc's or a Slides file's
 * `batchUpdate` with `writeControl.requiredRevisionId` is: Google turning it down since the file
 * changed after that revision is a `conflict`, saying `stale`, which says what to read again;
 * anything else is as `googleWrite` answers it. Google says so as a 400 INVALID_ARGUMENT that the
 * required revision doesn't match the latest, and documents FAILED_PRECONDITION: either is taken,
 * a FAILED_PRECONDITION only where it is about the revision, as one for another reason is not.
 */
export async function googleRevisionWrite<S extends z.ZodType>(accessToken: string, url: URL, body: object, schema: S, stale: string): Promise<Result<z.infer<S>, ApiError>> {
	const init = {method: 'POST', headers: {...authHeaders(accessToken), 'content-type': 'application/json'}, body: JSON.stringify(body)};
	const answer = await httpRequest(url, init, {schema, timeoutMs: TIMEOUT_MS});
	return answer.mapErr((error) => (isStaleRevision(error) ? ApiErr.conflict(stale) : googleError(error)));
}

const STALE_REVISION = /required revision id .*does not match the latest revision/i;
const REVISION = /revision/i;

function isStaleRevision(error: FetchError): boolean {
	if (error.kind !== 'http' || error.status !== 400) {
		return false;
	}
	const google = readGoogleError(error);
	return STALE_REVISION.test(google.message) || (google.status === 'FAILED_PRECONDITION' && REVISION.test(google.message));
}

/** A write whose body is of its own type, text or bytes, as a file uploaded to Drive is, its answer read with `schema`. */
export async function googleUpload<S extends z.ZodType>(
	accessToken: string,
	method: WriteMethod,
	url: URL,
	content: {type: string; body: string | Blob},
	schema: S,
): Promise<Result<z.infer<S>, ApiError>> {
	const init = {method, headers: {...authHeaders(accessToken), 'content-type': content.type}, body: content.body};
	const answer = await httpRequest(url, init, {schema, timeoutMs: TIMEOUT_MS});
	return answer.mapErr(googleError);
}

/**
 * Metadata and content in one request, as Google's multipart uploads take them: the metadata as
 * JSON first, then the content, of its own type.
 */
export function multipartRelated(metadata: object, type: string, content: string | Uint8Array): {type: string; body: Blob} {
	const boundary = `proxy-${randomUUID()}`;
	// Bytes are copied into the body, which a view of memory shared with others can't be.
	const part = typeof content === 'string' ? content : new Uint8Array(content);
	const head = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata), `--${boundary}`, `Content-Type: ${type}`, '', ''].join('\r\n');
	return {type: `multipart/related; boundary=${boundary}`, body: new Blob([head, part, `\r\n--${boundary}--`])};
}

// How long a file's bytes may take to come down or go up whole, as a copy kept or given back does:
// far longer than a call's, for files of hundreds of megabytes.
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

/** A GET whose answer is a file's bytes, as they come, never held whole here. */
export async function googleStream(accessToken: string, url: URL): Promise<Result<ReadableStream<Uint8Array>, ApiError>> {
	const answer = await httpRequest(url, authorized(accessToken), {parse: 'response', timeoutMs: TRANSFER_TIMEOUT_MS});
	return answer.map((response) => response.body ?? new Blob([]).stream()).mapErr(googleError);
}

/**
 * A write whose body is a file's bytes as they come, as a copy given back is, `size` of them where
 * that is known; its answer read with `schema`.
 */
export async function googleTransfer<S extends z.ZodType>(
	accessToken: string,
	method: WriteMethod,
	url: URL,
	content: {type: string; body: ReadableStream<Uint8Array>; size: number | null},
	schema: S,
): Promise<Result<z.infer<S>, ApiError>> {
	const length: Record<string, string> = content.size === null ? {} : {'content-length': String(content.size)};
	const init = {method, headers: {...authHeaders(accessToken), 'content-type': content.type, ...length}, body: content.body};
	const answer = await httpRequest(url, init, {schema, timeoutMs: TRANSFER_TIMEOUT_MS});
	return answer.mapErr(googleError);
}

/**
 * Starts a resumable upload at Drive, for bytes of `type`, `size` of them where that is known, with
 * `metadata` as JSON: the session's address, where the bytes are then sent, which Google answers in
 * `Location`.
 */
export function googleSession(accessToken: string, method: WriteMethod, url: URL, content: {type: string; size: number | null; metadata: object}): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const length: Record<string, string> = content.size === null ? {} : {'x-upload-content-length': String(content.size)};
		const headers = {...authHeaders(accessToken), 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': content.type, ...length};
		const answer = await httpRequest(url, {method, headers, body: JSON.stringify(content.metadata)}, {parse: 'response', timeoutMs: TIMEOUT_MS});
		const response = $(answer.mapErr(googleError));
		await Result.wrapAsync(() => response.body?.cancel() ?? Promise.resolve());
		const location = response.headers.get('location');
		if (location === null) {
			return $(Err(ApiErr.providerUnreachable(new Error('Google started an upload without saying where to send it'))));
		}
		return location;
	});
}

/** A DELETE, whose answer is empty. */
export async function googleDelete(accessToken: string, url: URL): Promise<Result<void, ApiError>> {
	const answer = await httpRequest(url, {...authorized(accessToken), method: 'DELETE'}, {timeoutMs: TIMEOUT_MS});
	return answer.mapErr(googleError);
}

/** The app's Google client, which signing in and refreshing both need. */
export function requireGoogleClient(): Result<GoogleClient, ApiError> {
	const client = googleOAuthClient();
	if (!client) {
		return Err(ApiErr.validationError('Google isn’t set up on this server: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing'));
	}
	return Ok(client);
}

/** How a Google connection's tokens are refreshed: with the app's own client. */
export const googleRefresher: TokenRefresher<GoogleCredential> = {
	name: 'Google',
	schema: googleCredentialSchema,
	isExpiring,
	refresh: (credential) =>
		Do(async ($) => {
			return $(await refreshGoogleTokens($(requireGoogleClient()), credential));
		}),
};

/**
 * Calls Google with a connection's access token: refreshed first when it is running out, and once
 * more when Google turns it down anyway. A connection Google won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function callGoogle<T>(connection: StoredConnection, call: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callWithToken(googleRefresher, connection, (credential) => call(credential.accessToken));
}
