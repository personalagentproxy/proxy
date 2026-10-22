import addressparser from 'nodemailer/lib/addressparser';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import type {RecordTarget} from './connector';

/**
 * A reply to an email, as the home page writes one, whatever the mailbox: from the connection's
 * address, in the email's thread, sent at once or saved as a draft. Each mailbox's connector reads
 * the email and writes the reply in its own terms.
 */

/** What is written back, and whether it goes out now or waits in the drafts. */
export type Reply = {body: string; send: boolean};

/** The email a reply answers, as its headers say. */
export type Answered = {from: string; replyTo: string; to: string; subject: string; messageId: string; references: string};

/** What a reply is written with besides its text: who it goes to, its subject, and the thread it joins. */
export type ReplyHeaders = {to: string; subject: string; inReplyTo: string; references: string};

/** How a mailbox replies to its email `emailId`, as found by its search: the reply's headers, once written. */
export type MailReply = (target: RecordTarget, emailId: string, reply: Reply) => Promise<Result<ReplyHeaders, ApiError>>;

function addresses(header: string): string[] {
	return addressparser(header, {flatten: true}).flatMap(({address}) => (address ? [address.toLowerCase()] : []));
}

/**
 * The reply's headers, as a mail app writes them: to whoever the email asks replies to go to, else
 * its sender, or, for an email `account` sent, to whom it went; under its subject, "Re:" once; after
 * the email in its thread.
 */
export function replyHeaders(account: string, answered: Answered): ReplyHeaders {
	const own = addresses(answered.from).includes(account.toLowerCase());
	const to = own ? answered.to : answered.replyTo || answered.from;
	const subject = /^re:/i.test(answered.subject.trim()) ? answered.subject.trim() : `Re: ${answered.subject.trim()}`.trim();
	const references = [answered.references.trim(), answered.messageId.trim()].filter((one) => one !== '').join(' ');
	return {to, subject, inReplyTo: answered.messageId.trim(), references};
}
