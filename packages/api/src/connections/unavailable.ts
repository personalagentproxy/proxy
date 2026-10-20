import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findIntegration, type Integration} from '@proxy/integrations';

import {log, serializeError} from '../observability/log';
import {readGoogleCredential} from './google/google-oauth';
import {unavailableGoogleActions} from './google/scopes';

/**
 * The actions a connection's sign-in didn't cover, which no default or agent setting turns on:
 * Google's consent screen lets a person untick some of what is asked for, so its connections keep
 * what Google granted. Every other integration's sign-in covers all its actions. A connection
 * without a credential, as one moved over from a custom MCP server that had none of the
 * integration's (`take-over-custom.ts`), covers none until it is signed in to.
 */

type StoredConnection = {id: string; integrationId: string; credential: string | null};

/** Whether the connection has no sign-in at all, as one moved over from a custom MCP server may not. Information is never signed in to. */
export function needsSignIn(connection: StoredConnection): boolean {
	return connection.credential === null && !findIntegration(connection.integrationId)?.builtIn;
}

/**
 * The connection's actions its sign-in didn't cover, in the catalog's order. A credential that
 * can't be read, as after a change of `ENCRYPTION_KEY`, covers none, so the rest of the
 * organization's connections are listed and used as before and this one can still be deleted.
 */
export function unavailableActions(connection: StoredConnection): string[] {
	if (needsSignIn(connection)) {
		return findIntegration(connection.integrationId)?.actions.map((action) => action.id) ?? [];
	}
	if (connection.integrationId !== 'google') {
		return [];
	}
	const credential = readGoogleCredential(connection.credential);
	if (credential.isErr()) {
		log.warn('A Google credential could not be read', {connectionId: connection.id, ...('cause' in credential.error ? serializeError(credential.error.cause) : {})});
		return findIntegration(connection.integrationId)?.actions.map((action) => action.id) ?? [];
	}
	return unavailableGoogleActions(credential.value);
}

/** The refusal of every action of a connection that has no sign-in, saying how to give it one. */
export function signInNeededError(integration: Integration): ApiError {
	return ApiErr.validationError(`This ${integration.name} connection isn't signed in yet. Sign in to ${integration.name} on its page in Personal Agent Proxy to use it.`);
}

/** The refusal of an action the sign-in didn't cover, saying how to allow it. */
export function unavailableError(integration: Integration, actionId: string): ApiError {
	const label = integration.actions.find((action) => action.id === actionId)?.label ?? actionId;
	return ApiErr.validationError(`${integration.name} didn't allow ${label} at sign-in. Sign in to ${integration.name} again to allow it.`);
}

/** Refuses turning on an action the sign-in didn't cover; turning one off, or back to the default, is fine. */
export function refuseUnavailable(integration: Integration, unavailable: string[], actions: Record<string, boolean | null>): Result<void, ApiError> {
	const turnedOn = Object.keys(actions).find((id) => actions[id] === true && unavailable.includes(id));
	if (turnedOn !== undefined) {
		return Err(unavailableError(integration, turnedOn));
	}
	return Ok(undefined);
}
