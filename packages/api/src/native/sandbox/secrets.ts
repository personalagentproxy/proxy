import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {VAULT_INTEGRATION_ID} from '@proxy/integrations';

import type {TaskCaller} from '../../agent-side/tools';
import {listSecrets} from '../vault/connector';
import {type GivenSecret, type HeldSecret, pickSecret} from './secret-values';

/**
 * The secrets of a sandbox command: those it is given as environment variables, by the names the
 * agent asked for, and those shown by their names wherever what it writes has their values,
 * every secret of the vaults the agent may use the secrets of, asked for or not.
 */
export type CommandSecrets = {given: GivenSecret[]; masked: GivenSecret[]};

/**
 * The vaults' secrets for a sandbox command, from the vaults the agent has Use secrets on. What a
 * command is given it can read, and send anywhere, which the permission says: masking what it
 * writes back (secret-values.ts) keeps a value out of the agent's answers by accident, as when a
 * command prints its environment or a file one wrote before, not from an agent set on reading it.
 * Masked on every call, since a value one command wrote to a file another may print.
 */
export function secretsFor(caller: TaskCaller, asked: string[]): Promise<Result<CommandSecrets, ApiError>> {
	return Do(async ($) => {
		// Read when asked for: the agent side runs every tool, this one among them, so importing it
		// as this file loads would load the whole of it with any sandbox module.
		const {listAgentConnections} = await import('../../agent-side/tools');
		const {connections} = $(await listAgentConnections(caller.agent));
		const vaults = connections.filter((connection) => connection.integrationId === VAULT_INTEGRATION_ID && connection.actions.includes('useSecrets'));
		if (vaults.length === 0 && asked.length > 0) {
			return $(Err(ApiErr.validationError('No vault lets you use its secrets: the person turns on Use secrets for one on its page.')));
		}
		const lists = await Promise.all(vaults.map(async (vault) => (await listSecrets(vault.id)).map((secrets) => secrets.map((secret): HeldSecret => ({...secret, vault})))));
		const held = lists.flatMap((list) => $(list));
		const given = [...new Set(asked)].map((name) => $(pickSecret(held, name)));
		return {given, masked: held.map(({name, value}) => ({name, value}))};
	});
}
