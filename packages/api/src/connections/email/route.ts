import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createConnection, listConnections} from '@proxy/db/connection';
import {EMAIL_PROVIDERS, type EmailProvider, type MailServers} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptCredential} from '../../utils/credential-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import type {EmailCredential} from './credential';
import {checkMailbox} from './mail-check';

const hostnameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Not a hostname');

// Only the standard mail ports, so a typed-in server can't point the api at anything else on its
// network.
const connectEmailBodySchema = z.object({
	provider: z.enum(EMAIL_PROVIDERS.map((provider) => provider.id)),
	email: z.string().trim().toLowerCase().pipe(z.email()),
	password: z.string().min(1),
	servers: z.object({imapHost: hostnameSchema, smtpHost: hostnameSchema, smtpPort: z.union([z.literal(465), z.literal(587)])}).optional(),
});

type ConnectEmailBody = z.infer<typeof connectEmailBodySchema>;

function serversFor(provider: EmailProvider, body: ConnectEmailBody): Result<MailServers, ApiError> {
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

/**
 * Connects a mailbox with an app password. Signs in over IMAP and SMTP first, so a wrong password
 * or server is reported now rather than on an agent's first request. A new connection gives agents
 * nothing until a default or an agent's own setting says otherwise.
 */
export function handleConnectEmailRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(connectEmailBodySchema, request.body));
		const provider = EMAIL_PROVIDERS.find((candidate) => candidate.id === body.provider);
		if (!provider) {
			return $(Err(ApiErr.validationError('Unknown provider')));
		}

		const orgId = $(await requireUserOrgId(request));
		const existing = $(await listConnections(orgId));
		if (existing.some((connection) => connection.integrationId === 'email' && connection.account === body.email)) {
			return $(Err(ApiErr.conflict('This mailbox is already connected')));
		}

		const credential: EmailCredential = {...$(serversFor(provider, body)), username: body.email, password: passwordFor(provider, body.password)};
		const encrypted = $(encryptCredential(JSON.stringify(credential)));
		$(await checkMailbox(credential));

		const row = $(await createConnection({orgId, integrationId: 'email', account: body.email, credential: encrypted}));
		return toConnectionResponse(row);
	});
}
