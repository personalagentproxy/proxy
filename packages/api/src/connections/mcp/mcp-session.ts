import {Err, Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {updateConnectionCredential} from '@proxy/db/connection';

import {log} from '../../observability/log';
import {encryptSecret} from '../../utils/secret-crypto';
import {readStoredJson} from '../../utils/stored-json';
import {callMcpTool} from './mcp-client';
import {isExpiring, mcpCredentialSchema, refreshMcpTokens, type McpServer} from './mcp-oauth';

type StoredConnection = {id: string; credential: string | null};

// The tokens, and whatever else the credential holds beside them, as a custom server's address and
// endpoints, kept as it is when the tokens are replaced.
const storedCredentialSchema = mcpCredentialSchema.loose();

type StoredCredential = z.infer<typeof storedCredentialSchema>;

// The credential as stored, encrypted, beside what it holds.
type Session = {stored: string; credential: StoredCredential};

// Refreshes under way on this server, by connection and the credential they replace, so requests
// running at once share one: Notion turns down a refresh token used after it was replaced, and
// revokes the whole sign-in for it.
const renewing = new Map<string, Promise<Result<Session, ApiError>>>();

function readSession(server: McpServer, connection: StoredConnection): Result<Session, ApiError> {
	return Do<Session, ApiError>(($) => {
		const stored = $(requirePresent(connection.credential, ApiErr.internalError(new Error(`${server.name} connection without a credential`))));
		return {stored, credential: $(readStoredJson(stored, storedCredentialSchema))};
	});
}

// New tokens, saved for the next request unless another server saved its own first; this request
// goes on with these either way.
function refresh(server: McpServer, connectionId: string, session: Session): Promise<Result<Session, ApiError>> {
	return Do(async ($) => {
		const credential: StoredCredential = {...session.credential, ...$(await refreshMcpTokens(server, session.credential))};
		const stored = $(encryptSecret(JSON.stringify(credential)));
		const saved = $(await updateConnectionCredential({connectionId, credential: stored, previous: session.stored}));
		if (!saved) {
			log.warn(`${server.name} tokens were refreshed twice at once`, {connectionId});
		}
		return {stored, credential};
	});
}

function renew(server: McpServer, connectionId: string, session: Session): Promise<Result<Session, ApiError>> {
	const key = `${connectionId}:${session.stored}`;
	const running = renewing.get(key);
	if (running) {
		return running;
	}
	const renewal = refresh(server, connectionId, session).finally(() => renewing.delete(key));
	renewing.set(key, renewal);
	return renewal;
}

/**
 * Runs `use` with a connection's access token: refreshed first when it is running out, and once
 * more when the server turns it down anyway. A connection the server won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function withMcpToken<T>(server: McpServer, connection: StoredConnection, use: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const read = $(readSession(server, connection));
		const session = isExpiring(read.credential) ? $(await renew(server, connection.id, read)) : read;
		const first = await use(session.credential.accessToken);
		if (first.isOk() || first.error.kind !== 'credentials_rejected') {
			return $(first);
		}
		if (session !== read) {
			return $(Err(first.error));
		}

		const renewed = $(await renew(server, connection.id, session));
		return $(await use(renewed.credential.accessToken));
	});
}

/** Calls one of a server's tools with a connection's token, refreshed as `withMcpToken` does. */
export function callMcpToolFor(server: McpServer, connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return withMcpToken(server, connection, (accessToken) => callMcpTool(server, accessToken, name, args));
}
