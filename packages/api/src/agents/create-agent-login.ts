import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {createAgent, isProviderConflict, isUsernameConflict, type AgentRow, type AgentViewer} from '@proxy/db/agent';
import {CUSTOM_AGENT_NAME_MAX, findAgentProvider, type AgentProvider} from '@proxy/integrations';

import {generatePassword, generateUsername} from './credentials';

const MAX_USERNAME_ATTEMPTS = 5;

// A provider's login is named by the provider; a custom agent by the person, who has to name it.
function nameFor(provider: AgentProvider, name: string | undefined): Result<string, ApiError> {
	if (!provider.custom) {
		return Ok(provider.name);
	}
	const trimmed = name?.trim() ?? '';
	if (trimmed.length === 0) {
		return Err(ApiErr.validationError('Name the agent'));
	}
	if (trimmed.length > CUSTOM_AGENT_NAME_MAX) {
		return Err(ApiErr.validationError(`An agent's name is at most ${CUSTOM_AGENT_NAME_MAX} characters`));
	}
	return Ok(trimmed);
}

/**
 * A new agent login for one of the providers, the viewer's own or, `shared`, every member's, with a
 * generated username and password; only the password's hash is kept, so this is the one time it is
 * known. A new agent follows every default. A provider the person already has a login for, or the
 * organization a shared one, is a conflict, as is a custom agent with the name of one there already.
 */
export function createAgentLogin(viewer: AgentViewer, providerId: string, options: {name?: string; shared?: boolean} = {}): Promise<Result<{agent: AgentRow; password: string}, ApiError>> {
	return Do(async ($) => {
		const provider = $(requirePresent(findAgentProvider(providerId), ApiErr.parseError(`Unknown agent ${providerId}`)));
		const name = $(nameFor(provider, options.name));
		const password = generatePassword();
		const passwordHash = await Bun.password.hash(password);

		for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
			const created = await createAgent({
				orgId: viewer.orgId,
				ownerUserId: options.shared ? null : viewer.userId,
				createdById: viewer.userId,
				providerId: provider.id,
				name,
				username: generateUsername(name),
				passwordHash,
			});
			if (created.isOk()) {
				return {agent: created.value, password};
			}
			if (created.error.kind === 'conflict' || isProviderConflict(created.error)) {
				return $(Err(ApiErr.conflict(provider.custom ? `An agent named ${name} already exists` : `${provider.name} already has an agent login`)));
			}
			if (!isUsernameConflict(created.error)) {
				return $(created);
			}
		}
		return $(Err(ApiErr.internalError(new Error('Username retries exhausted'))));
	});
}
