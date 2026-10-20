import {builtInHosts, type BuiltInMcp} from './mcp/built-in';
import {EXA_MCP} from './exa/route';
import {GRANOLA_MCP} from './granola/route';
import {LINEAR_MCP} from './linear/route';
import {NOTION_MCP} from './notion/route';
import {PARALLEL_MCP} from './parallel/route';

/**
 * Every integration built on its provider's MCP server (`mcp/built-in.ts`). Adding one here gives
 * it its sign-in routes (`create-api-router.ts`), has the custom MCP form sign in to it when given
 * its server's address, and moves custom connections to its server over when the api starts. Its
 * catalog entry says it is signed in to (`signIn`), for the web app.
 */
export const BUILT_IN_MCP: BuiltInMcp[] = [GRANOLA_MCP, NOTION_MCP, LINEAR_MCP, EXA_MCP, PARALLEL_MCP];

/** The integration that takes over a custom MCP server at this host, if one does. */
export function builtInForHost(host: string): BuiltInMcp | undefined {
	return BUILT_IN_MCP.find((builtIn) => builtInHosts(builtIn).includes(host.toLowerCase()));
}
