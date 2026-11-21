import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {VAULT_INTEGRATION_ID} from '@proxy/integrations';

import type {TaskCaller} from '../../agent-side/tools';
import {listSecrets} from '../vault/connector';
import {type GivenSecret, type HeldSecret, pickSecret} from './secret-values';

/**
 * The vaults' secrets a sandbox command is given, as environment variables, by the names the
 * agent asked for: only from vaults it has Use secrets on. The command can do what it likes with
 * what it is given, which the permission says; what it writes back has each value shown by its
 * name (secret-values.ts), so a key printed as it is never reaches the model.
 */
export function secretsFor(caller: TaskCaller, asked: string[]): Promise<Result<GivenSecret[], ApiError>> {
	return Do(async ($) => {
		if (asked.length === 0) {
			return [];
		}
		// Read when asked for: the agent side runs every tool, this one among them, so importing it
		// as this file loads would load the whole of it with any sandbox module.
		const {listAgentConnections} = await import('../../agent-side/tools');
		const {connections} = $(await listAgentConnections(caller.agent));
		const vaults = connections.filter((connection) => connection.integrationId === VAULT_INTEGRATION_ID && connection.actions.includes('useSecrets'));
		if (vaults.length === 0) {
			return $(Err(ApiErr.validationError('No vault lets you use its secrets: the person turns on Use secrets for one on its page.')));
		}
		const held: HeldSecret[] = [];
		for (const vault of vaults) {
			const secrets = $(await listSecrets(vault.id));
			held.push(...secrets.map((secret) => ({...secret, vault})));
		}
		return [...new Set(asked)].map((name) => $(pickSecret(held, name)));
	});
}
