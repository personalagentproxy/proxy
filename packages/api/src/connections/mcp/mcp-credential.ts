import {z} from 'zod';

import {mcpTokensSchema} from './mcp-oauth';

/**
 * What every connection to an MCP server stores, encrypted, built in or custom, in one shape: how
 * it signs in (`auth`) and what with. `none`: nothing, as a custom server that asks for no sign-in.
 * `token`: a token or API key, sent as the bearer token, or as written where it starts with its
 * scheme, as `Basic …` (`mcp-client.ts`). `oauth`: a sign-in, its client and tokens, refreshed as
 * they run out (`mcp-session.ts`). A custom server's adds its address, and a sign-in's the server's
 * endpoints (`custom/custom-mcp.ts`).
 */

export const noAuthSchema = z.object({auth: z.literal('none')});

export const tokenAuthSchema = z.object({auth: z.literal('token'), token: z.string()});

export const oauthAuthSchema = z.object({auth: z.literal('oauth'), ...mcpTokensSchema.shape});

/** What a connection of an integration built on its MCP server stores: a key, or a sign-in. */
export const builtInCredentialSchema = z.discriminatedUnion('auth', [tokenAuthSchema, oauthAuthSchema]);

export type BuiltInCredential = z.infer<typeof builtInCredentialSchema>;

export type OAuthCredential = z.infer<typeof oauthAuthSchema>;

// Before every MCP credential said how it signs in, an integration built in stored a key as
// `{auth: 'key', key}` and a sign-in's tokens bare. Read as they are now until the data migration
// `unify-mcp-credentials` has rewritten them, on every instance; it, and these, can then go.
const legacyKeySchema = z.object({auth: z.literal('key'), key: z.string()}).transform(({key}): BuiltInCredential => ({auth: 'token', token: key}));

const legacyTokensSchema = mcpTokensSchema.transform((tokens): BuiltInCredential => ({auth: 'oauth', ...tokens}));

/** A built-in integration's credential as stored, in the shape it has now or the one it had before. */
export const storedBuiltInCredentialSchema = z.union([builtInCredentialSchema, legacyKeySchema, legacyTokensSchema]);
