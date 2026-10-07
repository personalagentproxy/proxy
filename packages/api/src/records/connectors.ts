import {findIntegration, type IntegrationId} from '@proxy/integrations';

import type {Connector} from './connector';
import {emailConnector} from './email-connector';
import {granolaConnector} from './granola-connector';
import {infoConnector} from './info-connector';

const CONNECTORS: Record<IntegrationId, Connector> = {
	info: infoConnector,
	email: emailConnector,
	granola: granolaConnector,
};

export function connectorFor(integrationId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	return integration && CONNECTORS[integration.id];
}
