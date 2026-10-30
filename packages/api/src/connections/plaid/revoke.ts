import {type ApiError, Do} from '@proxy/utils';

import type {Revoke} from '../integration';
import {removeItem} from './plaid-api';
import {readPlaidCredential, requirePlaidClient} from './plaid-client';

/**
 * A bank login, removed at Plaid when its connection is deleted, which also ends what Plaid bills
 * for it; each connection is a login of its own. The person can still remove it at my.plaid.com
 * should that fail.
 */
export const REMOVE_PLAID_ITEM: Revoke = {
	per: 'connection',
	run: (connection) =>
		Do<void, ApiError>(async ($) => {
			$(await removeItem($(requirePlaidClient()), $(readPlaidCredential(connection.credential)).accessToken));
		}),
};
