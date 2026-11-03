import {vaultConnector} from '../../records/vault-connector';
import type {ApiIntegration} from '../integration';

/** The vault, in Personal Agent Proxy itself: always there, never connected or disconnected. */
export const VAULT_INTEGRATION: ApiIntegration = {
	id: 'vault',
	connectors: {entries: vaultConnector},
};
