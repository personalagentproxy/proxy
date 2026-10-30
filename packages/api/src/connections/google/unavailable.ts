import {findIntegration} from '@proxy/integrations';

import {log, serializeError} from '../../observability/log';
import type {StoredConnection} from '../integration';
import {readGoogleCredential} from './google-oauth';
import {unavailableGoogleActions} from './scopes';

/**
 * The actions a Google connection's sign-in didn't cover: Google's consent screen lets a person
 * untick some of what is asked for, so its connections keep what Google granted (`scopes.ts`). A
 * credential that can't be read, as after a change of `ENCRYPTION_KEY`, covers none, so the rest of
 * the organization's connections are listed and used as before and this one can still be deleted.
 */
export function unavailableGoogleConnectionActions(connection: StoredConnection): string[] {
	const credential = readGoogleCredential(connection.credential);
	if (credential.isErr()) {
		log.warn('A Google credential could not be read', {connectionId: connection.id, ...('cause' in credential.error ? serializeError(credential.error.cause) : {})});
		return findIntegration('google')?.actions.map((action) => action.id) ?? [];
	}
	return unavailableGoogleActions(credential.value);
}
