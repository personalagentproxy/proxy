import {findIntegration, type IntegrationId} from '@proxy/integrations';

import type {Connector} from './connector';
import {infoConnector} from './info-connector';

const CONNECTORS: Partial<Record<IntegrationId, Connector>> = {
	info: infoConnector,
};

export function connectorFor(integrationId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	return integration && CONNECTORS[integration.id];
}
