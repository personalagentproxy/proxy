import {alertsConnector, threadsConnector} from './connector';
import type {ApiIntegration} from '../../connections/integration';

/** Chat, in Personal Agent Proxy itself: a member's own threads and alerts, never connected or disconnected. */
export const CHAT_INTEGRATION: ApiIntegration = {
	id: 'chat',
	connectors: {threads: threadsConnector, alerts: alertsConnector},
};
