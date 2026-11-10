import {type ApiError, Do} from '@proxy/utils';
import {countSameAccountConnections} from '@proxy/db/connection';

import {log} from '../../observability/log';
import type {Revoke} from '../integration';
import {requireGitHubClient} from './github-app';
import {readGitHubCredential, revokeGitHubGrant} from './github-oauth';

/**
 * The person's authorization of the app at GitHub, revoked when a connection is deleted, so its
 * tokens stop working there too. It is the account's for the app as a whole, so it is kept while
 * another connection, in this organization or any other, is for the same account; what is for
 * the same account among the connections deleted along with it (`going`) doesn't keep it. The
 * person can still revoke it under their GitHub settings, Applications, should it fail.
 */
export const REVOKE_GITHUB: Revoke = {
	per: 'account',
	run: (connection, going) =>
		Do<void, ApiError>(async ($) => {
			const others = $(await countSameAccountConnections(connection.id, going));
			if (others > 0) {
				log.info('Kept the GitHub authorization another connection uses', {connectionId: connection.id});
				return;
			}
			$(await revokeGitHubGrant($(requireGitHubClient()), $(readGitHubCredential(connection.credential))));
		}),
};
