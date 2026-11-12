import {Result as ResultClass, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {ConnectionHealth} from '@proxy/contracts/connections';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import type {StoredConnection} from './integration';
import {apiIntegration} from './integrations';
import {requireConnection} from './managed';
import {needsSignIn} from './unavailable';

function failedCheck(error: ApiError): Pick<ConnectionHealth, 'status' | 'message'> {
	if (error.kind === 'credentials_rejected' || error.kind === 'unauthenticated') {
		return {status: 'sign_in_required', message: 'The provider rejected the saved credentials. Sign in again or replace the token.'};
	}
	if (error.kind === 'provider_unreachable') {
		return {status: 'unreachable', message: 'The provider could not be reached or did not answer the check. Try again later.'};
	}
	// Never expose a raw provider message: it may contain sensitive response data.
	return {status: 'error', message: 'The connection check failed. Its permissions or server configuration may need attention.'};
}

/** Does not run arbitrary tools or change saved tool permissions. OAuth may refresh normally. */
export async function checkConnection(connection: StoredConnection): Promise<ConnectionHealth> {
	const checkedAt = new Date().toISOString();
	if (needsSignIn(connection)) {
		return {status: 'sign_in_required', checkedAt, message: 'This connection has no saved sign-in. Sign in to use it.'};
	}
	const check = apiIntegration(connection.integrationId)?.check;
	if (!check) {
		return {status: 'unsupported', checkedAt, message: 'A live health check is not available for this connection type. Saved credentials alone do not confirm it works.'};
	}
	const attempted = await ResultClass.wrapAsync(() => check(connection));
	const result = attempted.mapErr(() => ApiErr.internalError(new Error('Connection health check failed'))).andThen((checked) => checked);
	if (result.isErr()) {
		return {...failedCheck(result.error), checkedAt: new Date().toISOString()};
	}
	return {status: 'healthy', checkedAt: new Date().toISOString(), message: 'The provider responded to a live connection check. Individual operations may need additional permissions.'};
}

/** Only visible connections are checked; a saved credential never leaves the server. */
export function handleCheckConnectionRoute(request: AuthenticatedRequest): Promise<Result<ConnectionHealth, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const connection = $(await requireConnection(viewer, request.params.connectionId ?? ''));
		return await checkConnection(connection);
	});
}
