import {apiIntegration} from '../connections/integrations';
import type {Connector} from './connector';

/**
 * The connector of an integration's collection, by their ids, from the integration's module
 * (`connections/integrations.ts`): each collection has one of its own, so a command runs on the
 * collection it was run on even where two share an id, as Google's Trash does for emails and files.
 * `connectors.test.ts` checks each against the catalog. A custom MCP server has none: its tools are
 * called as they are (`connections/custom`).
 */
export function connectorFor(integrationId: string, collectionId: string): Connector | undefined {
	return apiIntegration(integrationId)?.connectors[collectionId];
}
