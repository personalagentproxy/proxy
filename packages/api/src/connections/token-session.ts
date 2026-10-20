import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionCredential, updateConnectionCredential} from '@proxy/db/connection';

import {log} from '../observability/log';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';

/**
 * A connection's OAuth tokens, kept fresh: read from the encrypted credential, refreshed as they
 * run out, one refresh at a time per connection on each server, and saved only over the ones they
 * replace. Before refreshing, the credential is read again: a call earlier in the same request, or
 * another server, may have refreshed it already, and a refresh token is used only once. The MCP integrations use it; what a credential holds and how it is refreshed is the
 * provider's.
 */

type StoredConnection = {id: string; credential: string | null};

/** How one provider's credential is read and refreshed. */
export type TokenRefresher<C> = {
	// The provider's name in errors and logs: "Notion".
	name: string;
	// What the decrypted credential holds.
	schema: z.ZodType<C>;
	isExpiring: (credential: C) => boolean;
	// New tokens; turned down once the provider revoked the sign-in.
	refresh: (credential: C) => Promise<Result<C, ApiError>>;
};

// The credential as stored, encrypted, beside what it holds.
type Session<C> = {stored: string; credential: C};

// Refreshes under way on this server, by connection and the credential they replace, so requests
// running at once share one: Notion turns down a refresh token used after it was replaced, and
// revokes the whole sign-in for it. Each holds the new credential as stored, which every request
// sharing it reads for itself.
const renewing = new Map<string, Promise<Result<string, ApiError>>>();

function readSession<C>(refresher: TokenRefresher<C>, stored: string | null): Result<Session<C>, ApiError> {
	return Do<Session<C>, ApiError>(($) => {
		// One moved over from a custom MCP server without a sign-in has none until it is signed in to.
		const present = $(requirePresent(stored, ApiErr.credentialsRejected()));
		return {stored: present, credential: $(readStoredJson(present, refresher.schema))};
	});
}

// The credential as it is saved now: newer than the one read when another call or server
// refreshed it since. A connection deleted meanwhile keeps the one read.
function latestSession<C>(refresher: TokenRefresher<C>, connectionId: string, session: Session<C>): Promise<Result<Session<C>, ApiError>> {
	return Do(async ($) => {
		const stored = $(await getConnectionCredential(connectionId));
		if (stored === null || stored === session.stored) {
			return session;
		}
		return $(readSession(refresher, stored));
	});
}

// New tokens, saved for the next request unless another server saved its own first; this request
// goes on with these either way. Tokens saved since the credential was read are used instead, and
// refreshed only when they too are running out.
function refresh<C>(refresher: TokenRefresher<C>, connectionId: string, session: Session<C>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const latest = $(await latestSession(refresher, connectionId, session));
		if (latest.stored !== session.stored && !refresher.isExpiring(latest.credential)) {
			return latest.stored;
		}
		const refreshed = await refresher.refresh(latest.credential);
		if (refreshed.isErr()) {
			return $(await savedSince(refresher, connectionId, latest, refreshed.error));
		}
		const stored = $(encryptSecret(JSON.stringify(refreshed.value)));
		const saved = $(await updateConnectionCredential({connectionId, credential: stored, previous: latest.stored}));
		if (!saved) {
			log.warn(`${refresher.name} tokens were refreshed twice at once`, {connectionId});
		}
		return stored;
	});
}

// After a refresh that failed, the tokens another server saved meanwhile, else the failure.
function savedSince<C>(refresher: TokenRefresher<C>, connectionId: string, session: Session<C>, error: ApiError): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const latest = $(await latestSession(refresher, connectionId, session));
		if (latest.stored === session.stored) {
			return $(Err(error));
		}
		return latest.stored;
	});
}

// The refresh replacing this credential, started unless one already is.
function sharedRefresh<C>(refresher: TokenRefresher<C>, connectionId: string, session: Session<C>): Promise<Result<string, ApiError>> {
	const key = `${connectionId}:${session.stored}`;
	const running = renewing.get(key);
	if (running) {
		return running;
	}
	const renewal = refresh(refresher, connectionId, session).finally(() => renewing.delete(key));
	renewing.set(key, renewal);
	return renewal;
}

async function renew<C>(refresher: TokenRefresher<C>, connectionId: string, session: Session<C>): Promise<Result<Session<C>, ApiError>> {
	const stored = await sharedRefresh(refresher, connectionId, session);
	return stored.andThen((renewed) => readSession(refresher, renewed));
}

/** How a credential is kept fresh through one call: whether it is running out, and new tokens for it. */
export type Freshening<C> = {isExpiring: (credential: C) => boolean; refresh: (credential: C) => Promise<Result<C, ApiError>>};

/**
 * Makes a call with a credential: refreshed first when it is running out, and once more when the
 * provider turns it down anyway. The policy alone, for whoever keeps the tokens: a connection's
 * (`callWithToken`), or a custom MCP connection being moved over, which keeps them under a lock
 * (`take-over-custom.ts`).
 */
export function callWithRefresh<C, T>(fresh: Freshening<C>, credential: C, call: (credential: C) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const current = fresh.isExpiring(credential) ? $(await fresh.refresh(credential)) : credential;
		const first = await call(current);
		if (first.isOk() || first.error.kind !== 'credentials_rejected') {
			return $(first);
		}
		if (current !== credential) {
			return $(Err(first.error));
		}

		const renewed = $(await fresh.refresh(current));
		return $(await call(renewed));
	});
}

/**
 * Makes a call with a connection's credential, kept fresh as `callWithRefresh` does, the new tokens
 * saved on the connection. A connection the provider won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function callWithToken<C, T>(refresher: TokenRefresher<C>, connection: StoredConnection, call: (credential: C) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const read = $(readSession(refresher, connection.credential));
		const fresh: Freshening<Session<C>> = {
			isExpiring: (session) => refresher.isExpiring(session.credential),
			refresh: (session) => renew(refresher, connection.id, session),
		};
		return $(await callWithRefresh(fresh, read, (session) => call(session.credential)));
	});
}
