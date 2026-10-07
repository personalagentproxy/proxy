import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {createAgent, isProviderConflict, isUsernameConflict, type AgentRow} from '@proxy/db/agent';
import {findAgentProvider} from '@proxy/integrations';

import {generatePassword, generateUsername} from './credentials';

const MAX_USERNAME_ATTEMPTS = 5;

/**
 * A new agent login for one of the providers, with a generated username and password; only the
 * password's hash is kept, so this is the one time it is known. A new agent follows every default.
 * A provider the organization already has a login for is a conflict.
 */
export function createAgentLogin(orgId: string, providerId: string): Promise<Result<{agent: AgentRow; password: string}, ApiError>> {
	return Do(async ($) => {
		const provider = $(requirePresent(findAgentProvider(providerId), ApiErr.parseError(`Unknown agent ${providerId}`)));
		const password = generatePassword();
		const passwordHash = await Bun.password.hash(password);

		for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
			const created = await createAgent({orgId, providerId: provider.id, name: provider.name, username: generateUsername(provider.name), passwordHash});
			if (created.isOk()) {
				return {agent: created.value, password};
			}
			if (isProviderConflict(created.error)) {
				return $(Err(ApiErr.conflict(`${provider.name} already has an agent login`)));
			}
			if (!isUsernameConflict(created.error)) {
				return $(created);
			}
		}
		return $(Err(ApiErr.internalError(new Error('Username retries exhausted'))));
	});
}
