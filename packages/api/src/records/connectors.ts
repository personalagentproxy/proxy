import {findIntegration, type IntegrationId} from '@proxy/integrations';

import type {Connector} from './connector';
import {emailConnector} from './email-connector';
import {googleConnector} from './google-connector';
import {granolaConnector} from './granola-connector';
import {infoConnector} from './info-connector';
import {linearConnector} from './linear-connector';
import {notionConnector} from './notion-connector';
import {plaidConnector} from './plaid-connector';
import {sqlConnector} from './sql-connector';

// A custom MCP server has no records: its tools are called as they are (`connections/custom`).
const CONNECTORS: Record<Exclude<IntegrationId, 'mcp'>, Connector> = {
	info: infoConnector,
	email: emailConnector,
	granola: granolaConnector,
	notion: notionConnector,
	linear: linearConnector,
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
