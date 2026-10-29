import type {IntegrationId} from '@proxy/integrations';

import {replyToMailbox} from '../records/email-connector';
import type {MailReply} from '../records/email-reply';
import {replyToGmail} from '../records/google-emails';
import type {Source} from './sources';

// How an integration's mail is replied to; a mail integration joins Reply to email with one.
const REPLIES: Partial<Record<IntegrationId, MailReply>> = {google: replyToGmail, email: replyToMailbox};

/** How the mailbox replies to its email, or null for one that can't. */
export function replierFor(source: Source): MailReply | null {
	return REPLIES[source.integration.id] ?? null;
}
