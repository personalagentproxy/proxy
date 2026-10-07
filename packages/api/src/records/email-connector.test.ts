import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

// A mailbox in memory: the folders the server marks, and the messages of the one that is open.
type Folder = {path: string; specialUse?: string};

const UID_VALIDITY = 7n;

const imap = {
	folders: [] as Folder[],
	opened: '',
	calls: [] as Array<[string, ...unknown[]]>,
	message: null as null | {uid: number; flags: Set<string>; source: Buffer},
};

class FakeImapFlow {
	mailbox: {path: string; uidValidity: bigint; exists: number} | false = false;
	on() {}
	close() {}
	async connect() {}
	async logout() {}
	async list() {
		return imap.folders;
	}
	async getMailboxLock(path: string) {
		imap.opened = path;
		this.mailbox = {path, uidValidity: UID_VALIDITY, exists: 1};
		return {release: () => {}};
	}
	// One email in each folder, a day apart: the inbox's oldest, the draft's newest.
	async fetchAll() {
		const dates: Record<string, string> = {INBOX: '2026-10-01T09:00:00Z', 'Sent Items': '2026-10-02T09:00:00Z', Drafts: '2026-10-03T09:00:00Z'};
		const path = this.mailbox ? this.mailbox.path : '';
		return [{uid: 1, flags: new Set(), internalDate: new Date(dates[path] ?? 0), envelope: {subject: `In ${path}`, from: [], to: []}}];
	}
	async fetchOne(uid: string) {
		if (!imap.message || String(imap.message.uid) !== uid) {
			return false;
		}
		return {
			uid: imap.message.uid,
			flags: imap.message.flags,
			source: imap.message.source,
			internalDate: new Date('2026-10-01T09:00:00Z'),
			envelope: {
				subject: 'Re: Q3 planning',
				from: [{name: 'Sam', address: 'sam@example.com'}],
				to: [{address: 'sam@example.com'}],
			},
		};
	}
	async messageFlagsAdd(uid: string, flags: string[]) {
		imap.calls.push(['flagsAdd', uid, flags]);
		flags.forEach((flag) => imap.message?.flags.add(flag));
	}
	async messageFlagsRemove(uid: string, flags: string[]) {
		imap.calls.push(['flagsRemove', uid, flags]);
		flags.forEach((flag) => imap.message?.flags.delete(flag));
	}
	async messageMove(uid: string, path: string) {
		imap.calls.push(['move', uid, path]);
	}
	async messageDelete(uid: string) {
		imap.calls.push(['delete', uid]);
	}
	async append(path: string) {
		imap.calls.push(['append', path]);
		return {uid: 99};
	}
}

mock.module('imapflow', () => ({ImapFlow: FakeImapFlow}));

const sendMail = mock();

mock.module('../connections/email/mail-check', () => ({
	imapClientOptions: () => ({}),
	imapError: (cause: unknown) => ApiErr.providerUnreachable(cause),
	smtpError: (cause: unknown) => ApiErr.providerUnreachable(cause),
	smtpTransport: () => ({sendMail, close: () => {}}),
}));

const credential = {imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com', smtpPort: 465, username: 'alex@example.com', password: 'secret'};

// The stored credential, as decrypted; a test sets another SMTP server.
let smtpHost = credential.smtpHost;

mock.module('../utils/secret-crypto', () => ({decryptSecret: () => Ok(JSON.stringify({...credential, smtpHost}))}));

function emails(): Collection {
	const integration = findIntegration('email');
	const found = integration && findCollection(integration, 'emails');
	if (!found) {
		throw new Error('No emails collection');
	}
	return found;
}

const target = {
	connection: {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', createdAt: new Date(), defaults: [], credential: 'v1.encrypted'},
	collection: emails(),
};

const source = Buffer.from('From: sam@example.com\r\nTo: sam@example.com\r\nSubject: Re: Q3 planning\r\n\r\nSounds good, see you Thursday.\r\n');

const INBOX_EMAIL = `inbox-${UID_VALIDITY}-12`;
const DRAFT = `drafts-${UID_VALIDITY}-12`;

beforeEach(() => {
	imap.folders = [
		{path: 'INBOX', specialUse: '\\Inbox'},
		{path: 'Drafts', specialUse: '\\Drafts'},
		{path: 'Sent Items', specialUse: '\\Sent'},
		{path: 'Trash', specialUse: '\\Trash'},
		{path: 'Archive', specialUse: '\\Archive'},
	];
	imap.calls = [];
	imap.message = {uid: 12, flags: new Set(), source};
	sendMail.mockReset();
	sendMail.mockResolvedValue({messageId: '<sent@proxy>'});
	smtpHost = credential.smtpHost;
});

describe('emails', () => {
	test('one list of the inbox, drafts and sent mail, newest first, each saying where it is', async () => {
		const {emailConnector} = await import('./email-connector');
		const records = (await emailConnector.list(target)).unwrap();

		expect(records.map((record) => [record.id, record.values.folder])).toEqual([
			[`drafts-${UID_VALIDITY}-1`, 'Draft'],
			[`sent-${UID_VALIDITY}-1`, 'Sent'],
			[`inbox-${UID_VALIDITY}-1`, 'Inbox'],
		]);
	});

	test('a server without a Sent folder lists the rest', async () => {
		imap.folders = imap.folders.filter((folder) => folder.specialUse !== '\\Sent');

		const {emailConnector} = await import('./email-connector');
		const records = (await emailConnector.list(target)).unwrap();

		expect(records.map((record) => record.values.folder)).toEqual(['Draft', 'Inbox']);
	});

	test('an email in the inbox has a status from its flags', async () => {
		imap.message?.flags.add('\\Flagged');

		const {emailConnector} = await import('./email-connector');
		const record = (await emailConnector.get(target, INBOX_EMAIL)).unwrap();

		expect(record.values.status).toBe('Unread, Flagged');
		expect(record.values.body).toBe('Sounds good, see you Thursday.');
	});

	test('mark as read sets the seen flag and reads the email back', async () => {
		const {emailConnector} = await import('./email-connector');
		const record = (await emailConnector.commands?.markRead?.(target, INBOX_EMAIL))?.unwrap();

		expect(imap.calls).toEqual([['flagsAdd', '12', ['\\Seen']]]);
		expect(record?.values.status).toBe('Read');
	});

	test('archive moves the email out of the inbox, to All Mail where there is no Archive', async () => {
		imap.folders = imap.folders.filter((folder) => folder.specialUse !== '\\Archive').concat({path: '[Gmail]/All Mail', specialUse: '\\All'});

		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.commands?.archive?.(target, INBOX_EMAIL);

		expect(result?.unwrap()).toBeNull();
		expect(imap.opened).toBe('INBOX');
		expect(imap.calls).toEqual([['move', '12', '[Gmail]/All Mail']]);
	});

	test('move to Trash never deletes for good', async () => {
		const {emailConnector} = await import('./email-connector');
		await emailConnector.commands?.trash?.(target, INBOX_EMAIL);

		expect(imap.calls).toEqual([['move', '12', 'Trash']]);
	});

	test('a missing email is not found, and nothing is moved', async () => {
		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.commands?.trash?.(target, `inbox-${UID_VALIDITY}-404`);

		expect(result?.unwrapErr().kind).toBe('not_found');
		expect(imap.calls).toEqual([]);
	});
});

test('only drafts are edited or deleted', async () => {
	const {emailConnector} = await import('./email-connector');
	const updated = await emailConnector.update(target, INBOX_EMAIL, {to: '', subject: 'Hi', body: ''});
	const removed = await emailConnector.remove(target, INBOX_EMAIL);

	expect(updated.unwrapErr().kind).toBe('validation_error');
	expect(removed.unwrapErr().kind).toBe('validation_error');
	expect(imap.calls).toEqual([]);
});

describe('sending a draft', () => {
	test('sends from the connected address, files a copy in Sent and deletes the draft', async () => {
		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.commands?.send?.(target, DRAFT);

		expect(result?.unwrap()).toBeNull();
		expect(imap.opened).toBe('Drafts');
		expect(sendMail.mock.calls[0]?.[0]).toMatchObject({from: 'alex@example.com', to: 'sam@example.com', subject: 'Re: Q3 planning', text: 'Sounds good, see you Thursday.'});
		expect(imap.calls).toEqual([
			['append', 'Sent Items'],
			['delete', '12'],
		]);
	});

	test('Gmail files what it sends itself', async () => {
		smtpHost = 'smtp.gmail.com';

		const {emailConnector} = await import('./email-connector');
		await emailConnector.commands?.send?.(target, DRAFT);

		expect(imap.calls).toEqual([['delete', '12']]);
	});

	test('a draft that could not be sent stays', async () => {
		sendMail.mockRejectedValue(new Error('connection refused'));

		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.commands?.send?.(target, DRAFT);

		expect(result?.unwrapErr().kind).toBe('provider_unreachable');
		expect(imap.calls).toEqual([]);
	});

	test('once sent, a copy that cannot be filed does not fail the send', async () => {
		imap.folders = imap.folders.filter((folder) => folder.specialUse !== '\\Sent');

		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.commands?.send?.(target, DRAFT);

		expect(result?.unwrap()).toBeNull();
		expect(imap.calls).toEqual([['delete', '12']]);
	});
});

test('a new email is sent and filed in Sent, with no draft to delete', async () => {
	const {emailConnector} = await import('./email-connector');
	const result = await emailConnector.newCommands?.sendNew?.(target, {to: 'sam@example.com', subject: 'Friday', body: 'See you then.'});

	expect(result?.unwrap()).toBeNull();
	expect(sendMail.mock.calls[0]?.[0]).toMatchObject({from: 'alex@example.com', to: 'sam@example.com', subject: 'Friday', text: 'See you then.'});
	expect(imap.calls).toEqual([['append', 'Sent Items']]);
});

test('a new email without a recipient is not sent', async () => {
	const {emailConnector} = await import('./email-connector');
	const result = await emailConnector.newCommands?.sendNew?.(target, {to: ' ', subject: 'Friday', body: ''});

	expect(result?.unwrapErr().kind).toBe('validation_error');
	expect(sendMail).not.toHaveBeenCalled();
});
