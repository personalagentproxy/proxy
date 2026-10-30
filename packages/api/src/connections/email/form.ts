import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {EMAIL_PROVIDERS, type EmailProvider, type MailServers} from '@proxy/utils/email-providers';
import {mailboxBodySchema} from '@proxy/contracts/connections';

import type {ConnectForm} from '../form-connect';
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

// The mailbox a request describes, and its credential: the provider's servers or the typed-in ones,
// and the password as the server takes it.
function credentialFor(body: unknown): Result<{account: string; credential: EmailCredential}, ApiError> {
	return Do<{account: string; credential: EmailCredential}, ApiError>(($) => {
		const parsed = $(parseSchema(mailboxBodySchema, body));
		const provider = $(
			requirePresent(
				EMAIL_PROVIDERS.find((candidate) => candidate.id === parsed.provider),
				ApiErr.validationError('Unknown provider'),
			),
		);
		const servers = $(serversFor(provider, parsed));
		return {account: parsed.email, credential: {...servers, username: parsed.email, password: passwordFor(provider, parsed.password)}};
	});
}

/**
 * A mailbox, connected with an app password, the person's own or, `shared`, every member's. It is
 * signed in to over IMAP and SMTP first, so a wrong password or server is reported now rather than
 * on an agent's first request. A new connection gives agents nothing until a default or an agent's
 * own setting says otherwise.
 */
export const EMAIL_FORM: ConnectForm<EmailCredential> = {
	name: 'email',
	read: (request) => credentialFor(request.body),
	check: checkMailbox,
	defaults: [],
	conflict: 'This mailbox is already connected',
};
