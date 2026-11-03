import {apiIntegrations} from './integrations';
import {builtInHosts, type BuiltInMcp} from './mcp/built-in';

/**
 * Every integration built on its provider's MCP server (`mcp/built-in.ts`), as its module declares
 * it (`builtInMcpIntegration`), which gives it its sign-in routes (`create-api-router.ts`) and has
 * the custom MCP form sign in to it when given its server's address. Custom connections to its
 * server already made are moved over only by the data migration `take-over-custom-connections`
 * (`data-migrations/run.ts`), once per instance: one added after an instance ran it needs a data
 * migration of its own for that. Its catalog entry says it is signed in to (`signIn`), for the web app.
 */
export function builtInMcps(): BuiltInMcp[] {
	return apiIntegrations().flatMap((integration) => (integration.builtInMcp ? [integration.builtInMcp] : []));
}

/** The integration that takes over a custom MCP server at this host, if one does. */
export function builtInForHost(host: string): BuiltInMcp | undefined {
	return builtInMcps().find((builtIn) => builtInHosts(builtIn).includes(host.toLowerCase()));
}
