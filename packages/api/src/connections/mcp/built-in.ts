import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';

import type {McpServer} from './mcp-oauth';

/**
 * An integration built on its provider's MCP server, as Granola, Notion, Linear, Exa and Parallel
 * are: signed in to through the server, or connected with an API key where the server takes one
 * (`mcp-connect.ts`), and taking over the custom MCP connections people made to the same server
 * before it was built in (`take-over-custom.ts`). A custom server at one of its hosts can't be
 * added any more; one already there becomes a connection of the integration, its tools' settings
 * and runs as the integration's actions and requests.
 */

/** Params of a tool run, as the activity log kept them, as JSON. */
export const toolParamsSchema = z.record(z.string(), z.json());

/** Params of a tool run, as the activity log kept them; null when they were cut short, or not kept. */
export type ToolParams = z.infer<typeof toolParamsSchema> | null;

/** A run of a custom server's tool as the integration logs its own: a collection's list, open, write or command. */
export type MovedToolRun = {collectionId: string; operation: string; title?: string | null; query?: string | null};

/** What one of the server's tools becomes. */
export type MovedTool = {
	// The actions it was part of: one is on only where every tool that was part of it was on, so
	// moving over never allows more than before.
	actions: string[];
	// What a run of it becomes in the activity log; left a tool run without.
	run?: (params: ToolParams) => MovedToolRun;
};

export type BuiltInMcp = {
	integrationId: IntegrationId;
	server: McpServer;
	// Hosts beyond the server's own that are the same service, as Parallel's keyless server.
	otherHosts?: string[];
	// The account a sign-in or a key is for, asked with its access token or the key, as the
	// connection shows it: two sign-ins to the same
	// account are the same connection. Left out where the provider says nothing of who signed in,
	// as Exa and Parallel don't: every sign-in or key is a connection of its own, which only its
	// own page renews.
	account?: (accessToken: string) => Promise<Result<string, ApiError>>;
	// Also connected with an API key, sent as the bearer token (`apiKey` in the catalog): whether
	// the server takes a key, as only a call with it shows for a server that answers anyone until
	// a tool is called, and the query param a server's address may carry the key in
	// (`addressParam`), as Exa's own setup writes it: `?exaApiKey=`.
	apiKey?: {check: (key: string) => Promise<Result<void, ApiError>>; addressParam?: string};
	// The actions agents get with a new connection.
	defaults: string[];
	// The server's tools a custom connection was allowed, by name; any other's settings are dropped.
	tools: Record<string, MovedTool>;
};

/** The hosts whose custom MCP servers the integration takes over. */
export function builtInHosts(builtIn: BuiltInMcp): string[] {
	return [new URL(builtIn.server.url).host, ...(builtIn.otherHosts ?? [])];
}

/** The API key a server's address carries in its query, where the integration takes one there. */
export function keyInAddress(builtIn: BuiltInMcp, url: URL): string | null {
	const param = builtIn.apiKey?.addressParam;
	return (param && url.searchParams.get(param)?.trim()) || null;
}

/** A param's text, trimmed; null for anything else. */
export function textParam(params: ToolParams, key: string): string | null {
	const value = params?.[key];
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The first text of a list param, as the first page of `urls`. */
export function firstParam(params: ToolParams, key: string): string | null {
	const value = params?.[key];
	const first = Array.isArray(value) ? value[0] : undefined;
	return first === undefined ? null : textParam({first}, 'first');
}
