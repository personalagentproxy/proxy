import {findIntegration, type IntegrationId} from '@proxy/integrations';

import type {Connector} from './connector';
import {emailConnector} from './email-connector';
import {granolaConnector} from './granola-connector';
import {infoConnector} from './info-connector';
import {linearConnector} from './linear-connector';
import {notionConnector} from './notion-connector';
import {sqlConnector} from './sql-connector';
import {ticktickConnector} from './ticktick-connector';

const CONNECTORS: Record<IntegrationId, Connector> = {
	info: infoConnector,
	email: emailConnector,
	granola: granolaConnector,
	notion: notionConnector,
	linear: linearConnector,
	ticktick: ticktickConnector,
	postgres: sqlConnector('postgres'),
	mysql: sqlConnector('mysql'),
};

export function connectorFor(integrationId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	return integration && CONNECTORS[integration.id];
}
