import addressparser from 'nodemailer/lib/addressparser';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import type {NewCommandRunner, RecordTarget, RecordValues} from './connector';

/**
 * A reply to an email, as the home page and agents write one, whatever the mailbox: from the
 * connection's address, in the email's thread, sent at once or saved as a draft. Each mailbox's
 * connector reads the email and writes the reply in its own terms; agents write one as the
 * `replies` collection's commands.
 */

/** What is written back, whether it goes out now or waits in the drafts, and whether to everyone the email went to. */
export type Reply = {body: string; send: boolean; all: boolean};

/** The email a reply answers, as its headers say. */
export type Answered = {from: string; replyTo: string; to: string; cc: string; subject: string; messageId: string; references: string};

/** What a reply is written with besides its text: who it goes to, its subject, and the thread it joins. */
export type ReplyHeaders = {to: string; cc: string; subject: string; inReplyTo: string; references: string};

/**
 * A reply once written: its headers, its id, and on Gmail its thread. The id is the reply's among
 * email, as `emails_get` opens it, where it has one there: Gmail's message id, or a draft's id. A
 * reply sent over SMTP is only filed in Sent as the server takes it, so its id is its Message-ID.
 */
export type WrittenReply = ReplyHeaders & {id: string; thread: string};

/** How a mailbox replies to its email `emailId`, as found by a search or a list: the reply, once written. */
export type MailReply = (target: RecordTarget, emailId: string, reply: Reply) => Promise<Result<WrittenReply, ApiError>>;

type Address = {name: string; address: string};

function parsed(header: string): Address[] {
	return addressparser(header, {flatten: true}).flatMap(({name, address}) => (address ? [{name, address}] : []));
}

function addresses(header: string): string[] {
	return parsed(header).map(({address}) => address.toLowerCase());
}

// As a header writes it: `"Sam Lee" <sam@example.com>`, or the address alone.
function formatted({name, address}: Address): string {
	return name ? `"${name.replace(/["\\]/g, '\\$&')}" <${address}>` : address;
}

// The addresses of `header` but those in `left`, written as a header writes them.
function others(header: string, left: string[]): string[] {
	return parsed(header)
		.filter(({address}) => !left.includes(address.toLowerCase()))
		.map(formatted);
}

/**
 * The reply's headers, as a mail app writes them: to whoever the email asks replies to go to, else
 * its sender, or, for an email `account` sent, to whom it went; under its subject, "Re:" once; after
 * the email in its thread. A reply to all, as Gmail writes one, also goes to the others the email
 * went to, and copies whom it copied, never the account itself.
 */
export function replyHeaders(account: string, answered: Answered, all = false): ReplyHeaders {
	const own = addresses(answered.from).includes(account.toLowerCase());
	const to = own ? answered.to : answered.replyTo || answered.from;
	const subject = /^re:/i.test(answered.subject.trim()) ? answered.subject.trim() : `Re: ${answered.subject.trim()}`.trim();
	const references = [answered.references.trim(), answered.messageId.trim()].filter((one) => one !== '').join(' ');
	const thread = {subject, inReplyTo: answered.messageId.trim(), references};
	if (!all) {
		return {to, cc: '', ...thread};
	}
	const addressed = [account.toLowerCase(), ...addresses(to)];
	const alsoTo = own ? [] : others(answered.to, addressed);
	const cc = others(answered.cc, [...addressed, ...addresses(answered.to)]);
	return {to: [to, ...alsoTo].filter((one) => one !== '').join(', '), cc: cc.join(', '), ...thread};
}

/** A reply as the `replies` collection's record: the email answered, what was written, and where it went. */
function replyRunner(reply: MailReply, send: boolean): NewCommandRunner {
	return (target, values) =>
		Do(async ($) => {
			const email = (values.email ?? '').trim();
			if (email === '') {
				return $(Err(ApiErr.validationError('Say which email to reply to as email: its id, as a list gives it')));
			}
			const body = values.body ?? '';
			if (body.trim() === '') {
				return $(Err(ApiErr.validationError('Say what to reply as body')));
			}
			const replyAll = values.replyAll ?? '';
			const written = $(await reply(target, email, {body, send, all: replyAll === 'Yes'}));
			const record: RecordValues = {email, body, replyAll, to: written.to, cc: written.cc, subject: written.subject};
			if (written.thread) {
				record.thread = written.thread;
			}
			return {id: written.id, values: record, updatedAt: new Date().toISOString()};
		});
}

/** The `replies` collection's commands, by how the mailbox replies: sent at once, or saved as a draft. */
export function replyCommands(reply: MailReply): {send: NewCommandRunner; draft: NewCommandRunner} {
	return {send: replyRunner(reply, true), draft: replyRunner(reply, false)};
}
