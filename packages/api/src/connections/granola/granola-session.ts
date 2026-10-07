import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {updateConnectionCredential} from '@proxy/db/connection';

import {log} from '../../observability/log';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {callGranolaTool} from './granola-mcp';
import {granolaCredentialSchema, isExpiring, refreshGranolaTokens, type GranolaCredential} from './granola-oauth';

type StoredConnection = {id: string; credential: string | null};

// The credential as stored, encrypted, beside what it holds.
type Session = {stored: string; credential: GranolaCredential};

function readSession(connection: StoredConnection): Result<Session, ApiError> {
	return Do<Session, ApiError>(($) => {
		const stored = $(requirePresent(connection.credential, ApiErr.internalError(new Error('Granola connection without a credential'))));
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return {stored, credential: $(parseSchema(granolaCredentialSchema, parsed))};
	});
}

// New tokens, saved for the next request unless another server saved its own first; this request
// goes on with these either way.
function renew(connectionId: string, session: Session): Promise<Result<Session, ApiError>> {
	return Do(async ($) => {
		const credential = $(await refreshGranolaTokens(session.credential));
		const stored = $(encryptSecret(JSON.stringify(credential)));
		const saved = $(await updateConnectionCredential({connectionId, credential: stored, previous: session.stored}));
		if (!saved) {
			log.warn('Granola tokens were refreshed twice at once', {connectionId});
		}
		return {stored, credential};
	});
}

/**
 * Calls one of Granola's tools with a connection's token: refreshed first when it is running out,
 * and once more when Granola turns it down anyway. A connection Granola won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function callGranolaToolFor(connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const read = $(readSession(connection));
		const session = isExpiring(read.credential) ? $(await renew(connection.id, read)) : read;
		const first = await callGranolaTool(session.credential.accessToken, name, args);
		if (first.isOk() || first.error.kind !== 'credentials_rejected') {
			return $(first);
		}
		if (session !== read) {
			return $(Err(first.error));
		}

		const renewed = $(await renew(connection.id, session));
		return $(await callGranolaTool(renewed.credential.accessToken, name, args));
	});
}
