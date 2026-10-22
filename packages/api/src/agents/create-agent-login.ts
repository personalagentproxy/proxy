import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {createAgent, isUsernameConflict, type AgentRow} from '@proxy/db/agent';
import type {MemberViewer} from '@proxy/db/viewer';
import {AGENT_NAME_MAX, findAgentProvider, loginProviderIdFor, type AgentProvider} from '@proxy/integrations';

import {generatePassword, generateUsername} from './credentials';

const MAX_USERNAME_ATTEMPTS = 5;

/** A name the person gave an agent, trimmed: something, and not too long. */
export function parseAgentName(name: string): Result<string, ApiError> {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return Err(ApiErr.validationError('Name the agent'));
	}
	if (trimmed.length > AGENT_NAME_MAX) {
		return Err(ApiErr.validationError(`An agent's name is at most ${AGENT_NAME_MAX} characters`));
	}
	return Ok(trimmed);
}

// A login is named by the person, or else after its provider; a custom agent has no name of its
// provider's to go by, so the person has to name it.
function nameFor(provider: AgentProvider, name: string | undefined): Result<string, ApiError> {
	if (name !== undefined && name.trim() !== '') {
		return parseAgentName(name);
	}
	if (provider.custom) {
		return Err(ApiErr.validationError('Name the agent'));
	}
	return Ok(provider.name);
}

/**
 * A new agent login for one of the providers, the viewer's own or, `shared`, every member's, with a
 * generated username and password; only the password's hash is kept, so this is the one time it is
 * known. A new agent follows every default. There can be any number of logins of a provider.
 */
export function createAgentLogin(viewer: MemberViewer, providerId: string, options: {name?: string; shared?: boolean} = {}): Promise<Result<{agent: AgentRow; password: string}, ApiError>> {
	return Do(async ($) => {
		const product = $(requirePresent(findAgentProvider(providerId), ApiErr.parseError(`Unknown agent ${providerId}`)));
		const provider = $(requirePresent(findAgentProvider(loginProviderIdFor(product)), ApiErr.parseError(`Unknown login provider for ${providerId}`)));
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
			if (!isUsernameConflict(created.error)) {
				return $(created);
			}
		}
		return $(Err(ApiErr.internalError(new Error('Username retries exhausted'))));
	});
}
