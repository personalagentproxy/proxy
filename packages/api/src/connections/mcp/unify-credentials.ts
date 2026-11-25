import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {listIntegrationCredentials, rewriteConnectionCredential, type StoredCredentialRow} from '@proxy/db/connection';

import {worthRetrying} from '../../data-migrations/retry';
import {log, serializeError} from '../../observability/log';
import {encryptSecret} from '../../utils/secret-crypto';
import {readStoredJson} from '../../utils/stored-json';
import {builtInMcps} from '../built-in-mcp';
import {builtInCredentialSchema, type BuiltInCredential} from './mcp-credential';
import {mcpTokensSchema} from './mcp-oauth';

/**
 * The data migration `unify-mcp-credentials-again` (`data-migrations/run.ts`): every connection of an
 * integration built on its MCP server given its credential in the shape every MCP credential has
 * now (`mcp-credential.ts`), a key as `{auth: 'token', token}` rather than `{auth: 'key', key}`, and
 * a sign-in's tokens under `{auth: 'oauth'}` rather than bare. A custom server's were in it already.
 * Each is rewritten only while it is still the one read, so tokens refreshed meanwhile are never
 * undone; one that changed meanwhile, or couldn't be saved, has the migration tried again on the
 * next start. One that can't be read at all, as after a change of `ENCRYPTION_KEY`, is logged and
 * passed over, as it was unusable before too. Until it has run, a connection in the old shape can't
 * be used: the api reads only the shape credentials have now.
 */

// Before every MCP credential said how it signs in, an integration built in stored a key as
// `{auth: 'key', key}` and a sign-in's tokens bare. Only this migration reads them now.
const legacyKeySchema = z.object({auth: z.literal('key'), key: z.string()}).transform(({key}): BuiltInCredential => ({auth: 'token', token: key}));

const legacyTokensSchema = mcpTokensSchema.transform((tokens): BuiltInCredential => ({auth: 'oauth', ...tokens}));

// A built-in integration's credential as stored, in the shape it had before.
const legacyCredentialSchema = z.union([legacyKeySchema, legacyTokensSchema]);

// What became of one connection's credential.
type Rewrite = 'rewritten' | 'current' | 'changed';

function rewrite(row: StoredCredentialRow): Promise<Result<Rewrite, ApiError>> {
	return Do(async ($) => {
		if (readStoredJson(row.credential, builtInCredentialSchema).isOk()) {
			return 'current' as const;
		}
		const credential = $(readStoredJson(row.credential, legacyCredentialSchema));
		const encrypted = $(encryptSecret(JSON.stringify(credential)));
		const saved = $(await rewriteConnectionCredential({connectionId: row.id, previous: row.credential, credential: encrypted}));
		return saved ? ('rewritten' as const) : ('changed' as const);
	});
}

/** Rewrites every built-in MCP connection's credential in the shape it has now. */
export async function unifyMcpCredentials(): Promise<Result<void, ApiError>> {
	const rows = await listIntegrationCredentials(builtInMcps().map((builtIn) => builtIn.integrationId));
	if (rows.isErr()) {
		return Err(rows.error);
	}
	let retry = 0;
	let rewritten = 0;
	for (const row of rows.value) {
		const result = await rewrite(row);
		if (result.isErr()) {
			const details = {connectionId: row.id, kind: result.error.kind, ...('cause' in result.error ? serializeError(result.error.cause) : {})};
			if (!worthRetrying(result.error)) {
				log.error('An MCP credential can’t be read, so it stays as it is', details);
				continue;
			}
			retry += 1;
			log.warn('Rewriting an MCP credential failed, to be tried again on the next start', details);
			continue;
		}
		if (result.value === 'changed') {
			retry += 1;
			continue;
		}
		if (result.value === 'rewritten') {
			rewritten += 1;
		}
	}
	log.info('Rewrote MCP credentials in their current shape', {rewritten, retry});
	if (retry > 0) {
		return Err(ApiErr.internalError(new Error(`Rewriting ${retry} MCP credentials is left for the next start`)));
	}
	return Ok(undefined);
}
