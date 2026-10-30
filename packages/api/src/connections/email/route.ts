import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, listConnections} from '@proxy/db/connection';
import {EMAIL_PROVIDERS, type EmailProvider, type MailServers} from '@proxy/utils/email-providers';
import {type Connection, mailboxBodySchema, shareBodySchema} from '@proxy/contracts/connections';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptSecret} from '../../utils/secret-crypto';
import {requireViewer} from '../../utils/user-org';
import {respond} from '../connection-response';
import {ownership} from '../ownership';
import type {EmailCredential} from './credential';
import {checkMailbox} from './mail-check';

type MailboxBody = z.infer<typeof mailboxBodySchema>;

function serversFor(provider: EmailProvider, body: MailboxBody): Result<MailServers, ApiError> {
	const servers = provider.servers ?? body.servers;
	if (!servers) {
		return Err(ApiErr.validationError('Servers are needed for this provider'));
	}
	return Ok(servers);
}

// The known providers show app passwords in groups ("abcd efgh ijkl mnop") but sign in without the
// spaces. Another server's password is taken as typed.
function passwordFor(provider: EmailProvider, password: string): string {
	if (!provider.servers) {
		return password;
	}
	return password.replace(/\s/g, '');
}

// The credential a request describes: the provider's servers or the typed-in ones, and the
// password as the server takes it.
function credentialFor(body: unknown): Result<{email: string; credential: EmailCredential}, ApiError> {
	return Do<{email: string; credential: EmailCredential}, ApiError>(($) => {
		const parsed = $(parseSchema(mailboxBodySchema, body));
		const provider = $(
			requirePresent(
				EMAIL_PROVIDERS.find((candidate) => candidate.id === parsed.provider),
				ApiErr.validationError('Unknown provider'),
			),
		);
		const servers = $(serversFor(provider, parsed));
		return {email: parsed.email, credential: {...servers, username: parsed.email, password: passwordFor(provider, parsed.password)}};
	});
}

/** Signs in to the mailbox over IMAP and SMTP and saves nothing: the Test connection button. */
export function handleTestEmailRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {credential} = $(credentialFor(request.body));
		$(await checkMailbox(credential));
	});
}

/**
 * Connects a mailbox with an app password, the person's own or, `shared`, every member's. Signs in
 * over IMAP and SMTP first, so a wrong password or server is reported now rather than on an agent's
 * first request. A new connection gives agents nothing until a default or an agent's own setting
 * says otherwise.
 */
export function handleConnectEmailRoute(request: AuthenticatedRequest): Promise<Result<Connection, ApiError>> {
	return Do(async ($) => {
		const {email, credential} = $(credentialFor(request.body));
		const {shared = false} = $(parseSchema(shareBodySchema, request.body));

		const viewer = $(await requireViewer(request));
		const existing = $(await listConnections(viewer));
		if (existing.some((connection) => connection.integrationId === 'email' && connection.account === email)) {
			return $(Err(ApiErr.conflict('This mailbox is already connected')));
		}

		const encrypted = $(encryptSecret(JSON.stringify(credential)));
		$(await checkMailbox(credential));

		const row = $(await createConnection({...ownership(viewer, shared), integrationId: 'email', account: email, credential: encrypted}));
		return $(await respond({...row, credential: encrypted}));
	});
}
