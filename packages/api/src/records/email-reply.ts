import addressparser from 'nodemailer/lib/addressparser';
import {Err, type Result} from 'ts-results-es';

import {getUserTimeZone} from '@proxy/db/user';
import {ApiErr, type ApiError, Do} from '@proxy/utils';

import type {NewCommandRunner, RecordTarget, RecordValues} from './connector';

/**
 * A reply to an email, as the command bar and agents write one, whatever the mailbox: from the
 * connection's address, in the email's thread, sent at once or saved as a draft. Each mailbox's
 * connector reads the email and writes the reply in its own terms; agents write one as the
 * `replies` collection's commands.
 */

/**
 * What is written back, whether it goes out now or waits in the drafts, whether to everyone the
 * email went to, and whether the email is quoted below it, its time in `timeZone`.
 */
export type Reply = {body: string; send: boolean; all: boolean; quote: boolean; timeZone: string | null};

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

/** The email a reply quotes: who wrote it, when, its text, and its HTML where it has some. */
export type Quoted = {from: string; date: Date | null; text: string; html: string | null};

/** What a reply is written as: its text, and beside it an HTML version where the email is quoted. */
export type ReplyContent = {text: string; html: string | null};

// How Gmail writes a time in its "On … wrote:" line, as `Thu, Oct 1, 2026 at 9:00 AM`, in
// `timeZone`, else UTC; a time zone Intl doesn't know is read as UTC too.
function writtenAt(date: Date, timeZone: string | null): string {
	const zone = timeZone ?? 'UTC';
	const at = (zoneName: string) => {
		const day = new Intl.DateTimeFormat('en-US', {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: zoneName}).format(date);
		const time = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit', timeZone: zoneName}).format(date);
		// Newer ICU puts a narrow no-break space before AM and PM, which plain text mail apps show oddly.
		return `${day} at ${time}`.replace(/[\u202f\u00a0]/g, ' ');
	};
	try {
		return at(zone);
	} catch {
		return at('UTC');
	}
}

// The line above the quote, as Gmail writes it: `On Thu, Oct 1, 2026 at 9:00 AM Sam Lee <sam@example.com> wrote:`.
function attribution(quoted: Quoted, timeZone: string | null): string {
	const [writer] = parsed(quoted.from);
	const who = writer ? [writer.name, `<${writer.address}>`].filter((part) => part !== '').join(' ') : quoted.from.trim() || 'they';
	if (!quoted.date || Number.isNaN(quoted.date.getTime())) {
		return `${who} wrote:`;
	}
	return `On ${writtenAt(quoted.date, timeZone)} ${who} wrote:`;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Text as HTML, its lines kept.
function textAsHtml(text: string): string {
	return escapeHtml(text).replace(/\r?\n/g, '<br>\n');
}

// The part of an email's HTML that shows: what is inside its body, where it is a whole document.
function shownHtml(html: string): string {
	const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
	return (body?.[1] ?? html).trim();
}

/**
 * The reply as Gmail writes one: what was written, then the email it answers quoted below it,
 * under who wrote it and when, in `timeZone`. In the text each of the email's lines goes after
 * "> "; in the HTML, beside it, the email goes in Gmail's `gmail_quote` block, which Gmail folds
 * away, as a `blockquote type="cite"`, which Apple Mail and Thunderbird show as a quote. An email
 * without text is not quoted, and a reply without a quote is text alone.
 */
export function replyContent(body: string, quoted: Quoted | null, timeZone: string | null): ReplyContent {
	const text = (quoted?.text ?? '').replace(/\r\n/g, '\n').trim();
	if (!quoted || text === '') {
		return {text: body, html: null};
	}
	const line = attribution(quoted, timeZone);
	const lines = text.split('\n').map((one) => (one === '' ? '>' : `> ${one}`));
	const original = quoted.html ? shownHtml(quoted.html) : textAsHtml(text);
	const html = [
		`<div dir="ltr">${textAsHtml(body.trimEnd())}</div><br>`,
		'<div class="gmail_quote gmail_quote_container">',
		`<div dir="ltr" class="gmail_attr">${escapeHtml(line)}<br></div>`,
		`<blockquote class="gmail_quote" type="cite" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${original}</blockquote>`,
		'</div>',
	].join('\n');
	return {text: `${body.trimEnd()}\n\n${line}\n${lines.join('\n')}\n`, html};
}

/** The time zone of the person whose mailbox it is, for the quote's time: null where none is set or it can't be read. */
export async function replyTimeZone(userId: string | null): Promise<string | null> {
	if (!userId) {
		return null;
	}
	const found = await getUserTimeZone(userId);
	return found.isOk() ? found.value : null;
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
			const quote = values.quote ?? '';
			const timeZone = quote === 'No' ? null : await replyTimeZone(target.connection.ownerUserId);
			const written = $(await reply(target, email, {body, send, all: replyAll === 'Yes', quote: quote !== 'No', timeZone}));
			const record: RecordValues = {email, body, replyAll, quote, to: written.to, cc: written.cc, subject: written.subject};
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
