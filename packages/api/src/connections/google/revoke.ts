import {type ApiError, Do} from '@proxy/utils';
import {countSameAccountConnections} from '@proxy/db/connection';

import {log} from '../../observability/log';
import type {Revoke} from '../integration';
import {readGoogleCredential, revokeGoogleTokens} from './google-oauth';

/**
 * Google's grant, revoked when a connection is deleted, so its tokens stop working there too. A
 * grant is the account's for the app's Google client as a whole, every refresh token it has, so it
 * is kept while another connection, in this organization or any other, is for the same account, by
 * Google's id for it or its address; what is for the same account among the connections deleted
 * along with it (`going`) doesn't keep it. The person can still revoke it at
 * myaccount.google.com/permissions should it fail.
 */
export const REVOKE_GOOGLE: Revoke = {
	per: 'account',
	run: (connection, going) =>
		Do<void, ApiError>(async ($) => {
			const others = $(await countSameAccountConnections(connection.id, going));
			if (others > 0) {
				log.info('Kept the Google grant another connection uses', {connectionId: connection.id});
				return;
			}
			$(await revokeGoogleTokens($(readGoogleCredential(connection.credential))));
		}),
};
