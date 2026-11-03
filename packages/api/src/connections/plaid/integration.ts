import {plaidAccountsConnector, plaidTransactionsConnector} from '../../records/plaid-connector';
import type {ApiIntegration} from '../integration';
import {REMOVE_PLAID_ITEM} from './revoke';
import {handleConnectPlaidRoute, handleCreatePlaidLinkTokenRoute} from './route';

/** A bank, connected through Plaid Link, each bank login a connection of its own, removed at Plaid when it is deleted. */
export const PLAID_INTEGRATION: ApiIntegration = {
	id: 'plaid',
	connectors: {accounts: plaidAccountsConnector, transactions: plaidTransactionsConnector},
	connect: {kind: 'bank', name: 'Plaid', routes: () => ({handleConnect: handleConnectPlaidRoute, handleLinkToken: handleCreatePlaidLinkTokenRoute})},
	revoke: REMOVE_PLAID_ITEM,
};
