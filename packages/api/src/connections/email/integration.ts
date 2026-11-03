import {emailAttachmentsConnector, emailConnector, emailRepliesConnector} from '../../records/email-connector';
import {formConnect} from '../form-connect';
import type {ApiIntegration} from '../integration';
import {EMAIL_FORM} from './form';

/** A mailbox over IMAP and SMTP, connected on its form with an app password. */
export const EMAIL_INTEGRATION: ApiIntegration = {
	id: 'email',
	connectors: {emails: emailConnector, attachments: emailAttachmentsConnector, replies: emailRepliesConnector},
	connect: formConnect('email', EMAIL_FORM),
};
