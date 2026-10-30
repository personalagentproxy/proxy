import type {Result} from 'ts-results-es';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';
import {type Connection, shareBodySchema} from '@proxy/contracts/connections';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {connectWithForm} from './connect-flow';
import {respond} from './connection-response';
import type {ConnectRoutes} from './integration';

/**
 * An integration connected on a form of its own, as a mailbox is with an app password and a
 * database with its user's name and password: the account and credential a request's body
 * describes, the sign-in checking them with the provider, the actions agents get with a new
 * connection, and the refusal of an account already connected.
 */
export type ConnectForm<C> = {
	// The provider's name in the routes' names: "email", "Postgres".
	name: string;
	read: (request: AuthenticatedRequest) => Result<{account: string; credential: C}, ApiError>;
	check: (credential: C) => Promise<Result<void, ApiError>>;
	defaults: string[];
	conflict: string;
};

/**
 * The routes of a form: Test connection, which signs in and saves nothing, and Connect, which signs
 * in first and makes the connection, the person's own or, `shared`, every member's (`connectWithForm`).
 */
export function formConnectRoutes<C>(integrationId: IntegrationId, form: ConnectForm<C>) {
	return {
		handleTest: (request: AuthenticatedRequest): Promise<Result<void, ApiError>> =>
			Do(async ($) => {
				const {credential} = $(form.read(request));
				$(await form.check(credential));
			}),
		handleConnect: (request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> =>
			Do(async ($) => {
				const {account, credential} = $(form.read(request));
				const {shared = false} = $(parseSchema(shareBodySchema, request.body));
				const viewer = $(await requireViewer(request));
				const row = $(await connectWithForm(viewer, integrationId, {account, credential, check: form.check, defaults: form.defaults, conflict: form.conflict}, {shared}));
				return $(await respond(row));
			}),
	};
}

/** How an integration connected on a form is connected, for its module. */
export function formConnect<C>(integrationId: IntegrationId, form: ConnectForm<C>): ConnectRoutes {
	return {kind: 'form', name: form.name, routes: () => formConnectRoutes(integrationId, form)};
}
