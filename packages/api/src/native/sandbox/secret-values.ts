import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {AgentConnection} from '@proxy/contracts/agent-side';

/**
 * Secrets as a sandbox command is given them (secrets.ts finds them): the one a name asks for,
 * the environment they make, and what the command wrote with each value shown as its name.
 */

/** A secret as a command is given it. */
export type GivenSecret = {name: string; value: string};

/** A secret of a vault the agent may use the secrets of. */
export type HeldSecret = GivenSecret & {vault: AgentConnection};

// Whether the vault is the one a name was asked for in: by its id, or by what it is called, the
// person's own being called Vault.
function vaultCalled(vault: AgentConnection, called: string): boolean {
	return vault.id === called || vault.name === called || (vault.name === null && called.toLowerCase() === 'vault');
}

/** The secret a name asks for, among those held: the one vault that has it, or the one named, as Work/OPENAI_API_KEY. */
export function pickSecret(held: HeldSecret[], asked: string): Result<GivenSecret, ApiError> {
	const slash = asked.lastIndexOf('/');
	const name = slash === -1 ? asked : asked.slice(slash + 1);
	const vault = slash === -1 ? null : asked.slice(0, slash);
	const found = held.filter((secret) => secret.name === name && (vault === null || vaultCalled(secret.vault, vault)));
	if (found.length > 1) {
		return Err(ApiErr.validationError(`${name} is in more than one vault: ask for it as ${found.map((secret) => `${secret.vault.id}/${name}`).join(' or ')}`));
	}
	const [only] = found;
	if (!only) {
		return Err(ApiErr.notFound('secret', asked, 'secrets_list, in a vault you may use the secrets of, lists them.'));
	}
	return Ok({name: only.name, value: only.value});
}

// Values shorter than this are left as they are in what a command writes: a word that short is
// more likely to be anything else.
const MASKED_FROM = 4;

/** What a command wrote, each secret's value in it shown as [secret NAME], the longest first, so one inside another is never half shown. */
export function maskSecrets(text: string, secrets: GivenSecret[]): string {
	const masked = secrets.filter((secret) => secret.value.length >= MASKED_FROM).toSorted((a, b) => b.value.length - a.value.length);
	return masked.reduce((shown, secret) => shown.split(secret.value).join(`[secret ${secret.name}]`), text);
}

/** The secrets as environment variables, by their names. */
export function secretEnv(secrets: GivenSecret[]): Record<string, string> {
	return Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
}
