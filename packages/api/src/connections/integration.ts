import type {Result} from 'ts-results-es';
import type {z} from 'zod';

import type {ApiError} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';
import type {Connection, plaidLinkTokenSchema} from '@proxy/contracts/connections';

import type {Connector} from '../records/connector';
import type {AuthenticatedHandler, AuthenticatedResultHandler} from '../server/middleware/require-auth';
import type {BuiltInMcp} from './mcp/built-in';

/**
 * Everything the api knows about one integration of the catalog's, each in its provider's own
 * directory (`<provider>/integration.ts`) and all of them in `integrations.ts`: its collections'
 * connectors, how it is connected and so the routes it has, what is undone at the provider when a
 * connection of it is deleted, and the actions a connection's sign-in didn't cover.
 */

/** A connection about to be deleted, as what undoes it at its provider reads it. */
export type DisconnectedConnection = {id: string; integrationId: string; account: string; credential: string | null};

/** A connection with its stored credential, as what its sign-in covered is read from it. */
export type StoredConnection = {id: string; integrationId: string; credential: string | null};

/**
 * How an integration is connected, and so its routes (`create-api-router.ts`), each made when the
 * router is, since what makes them reaches this list in turn:
 * - `signIn`: signing in to the provider, the start at `/api/orgs/:org/connections/<id>/start`, a
 *   top-level navigation, and the callback at `/api/connections/<id>/callback`; and an API key at
 *   `/api/orgs/:org/connections/<id>`, where the provider takes one.
 * - `form`: a form of its own, connected at `/api/orgs/:org/connections/<id>` and tested, saving
 *   nothing, at `…/<id>/test`, as a mailbox and a database are.
 * - `bank`: Plaid Link in the browser, whose public token is exchanged at
 *   `/api/orgs/:org/connections/<id>`, with Link's token from `…/<id>/link-token`.
 * - `server`: a custom MCP server by its address, at `/api/orgs/:org/connections/<id>`, which
 *   connects it or begins its sign-in, coming back to `/api/connections/<id>/callback`.
 * `name` is the provider's in the routes' names, as the logs show them: "Start Google sign-in route".
 */
export type ConnectRoutes =
	| {kind: 'signIn'; name: string; routes: () => {handleStart: AuthenticatedHandler; handleCallback: AuthenticatedHandler; handleKey?: AuthenticatedResultHandler<Connection>}}
	| {kind: 'form'; name: string; routes: () => {handleConnect: AuthenticatedResultHandler<Connection>; handleTest: AuthenticatedResultHandler<void>}}
	| {kind: 'bank'; name: string; routes: () => {handleConnect: AuthenticatedResultHandler<Connection>; handleLinkToken: AuthenticatedResultHandler<z.infer<typeof plaidLinkTokenSchema>>}}
	| {kind: 'server'; name: string; routes: () => {handleConnect: AuthenticatedHandler; handleCallback: AuthenticatedHandler}};

/**
 * What is undone at the provider before a connection is deleted (`disconnect.ts`): `going` are the
 * connections deleted along with it, it included. One undone for an `account`, as Google's grant is,
 * is undone once for the connections of the same account deleted together; one for each
 * `connection`, as a Plaid bank login is, for each.
 */
export type Revoke = {per: 'account' | 'connection'; run: (connection: DisconnectedConnection, going: string[]) => Promise<Result<void, ApiError>>};

export type ApiIntegration = {
	id: IntegrationId;
	// Each collection's connector by the catalog's collection id (`records/connectors.ts`); none for
	// a custom MCP server, whose tools are called as they are.
	connectors: Partial<Record<string, Connector>>;
	// None for the vault, which is never connected.
	connect?: ConnectRoutes;
	// Built on its provider's MCP server (`built-in-mcp.ts`).
	builtInMcp?: BuiltInMcp;
	revoke?: Revoke;
	// The actions the connection's sign-in didn't cover, as Google's consent screen lets a person
	// untick some (`unavailable.ts`); every other integration's sign-in covers all its actions.
	unavailableActions?: (connection: StoredConnection) => string[];
};
