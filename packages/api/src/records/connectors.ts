import {findIntegration, type IntegrationId} from '@proxy/integrations';

import {cloudflareConnector} from './cloudflare-connector';
import type {Connector} from './connector';
import {emailConnector} from './email-connector';
import {googleConnector} from './google-connector';
import {granolaConnector} from './granola-connector';
import {linearConnector} from './linear-connector';
import {notionConnector} from './notion-connector';
import {plaidConnector} from './plaid-connector';
import {sqlConnector} from './sql-connector';
import {vaultConnector} from './vault-connector';
import {exaConnector, parallelConnector} from './web-connector';

// A custom MCP server has no records: its tools are called as they are (`connections/custom`).
const CONNECTORS: Record<Exclude<IntegrationId, 'mcp'>, Connector> = {
	vault: vaultConnector,
	email: emailConnector,
	granola: granolaConnector,
	notion: notionConnector,
	linear: linearConnector,
	cloudflare: cloudflareConnector,
	exa: exaConnector,
	parallel: parallelConnector,
	postgres: sqlConnector('postgres'),
	mysql: sqlConnector('mysql'),
	google: googleConnector,
	plaid: plaidConnector,
};

export function connectorFor(integrationId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	if (!integration || integration.id === 'mcp') {
		return undefined;
	}
	return CONNECTORS[integration.id];
}
