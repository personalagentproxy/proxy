import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, hasExperiment} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';

/**
 * Ask is an experiment: only an organization with `ask` on has its meetings, pages and issues
 * searched for it, or anything answered. Files and emails are searched for Find file and Find
 * email as well, so their routes ask nothing of it.
 */
export function requireAskExperiment(request: AuthenticatedRequest): Result<void, ApiError> {
	if (!hasExperiment(request.user, 'ask')) {
		return Err(ApiErr.forbidden());
	}
	return Ok(undefined);
}
