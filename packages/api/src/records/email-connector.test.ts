import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

// A mailbox in memory: the folders the server marks, each folder's messages by UID, and the one
// message the record tests open.
type Folder = {path: string; specialUse?: string};
type Address = {name?: string; address: string};
type Stored = {uid: number; date: string; subject: string; from?: Address[]; to?: Address[]};
type Criteria = {all?: boolean; uid?: string; text?: string; gmraw?: string; from?: string; since?: string; or?: Criteria[]; not?: Criteria; to?: string; cc?: string};

const UID_VALIDITY = 7n;

const imap = {
	folders: [] as Folder[],
	boxes: {} as Record<string, Stored[]>,
	gmail: false,
	opened: '',
	logins: 0,
	logouts: 0,
	closes: 0,
	fetches: 0,
	searches: [] as Criteria[],
	calls: [] as Array<[string, ...unknown[]]>,
	// What each append saved, as its text.
	appended: [] as string[],
	message: null as null | {uid: number; flags: Set<string>; source: Buffer},
};

function box(path: string): Stored[] {
	return imap.boxes[path] ?? [];
}

class FakeImapFlow {
	mailbox: {path: string; uidValidity: bigint; exists: number; uidNext: number} | false = false;
	get capabilities() {
		return new Set(imap.gmail ? ['X-GM-EXT-1'] : []);
	}
	on() {}
	close() {
		imap.closes += 1;
	}
	async connect() {
		imap.logins += 1;
	}
	async logout() {
		imap.logouts += 1;
	}
	async list() {
		return imap.folders;
	}
	async getMailboxLock(path: string) {
		imap.opened = path;
		const uids = box(path).map((message) => message.uid);
		this.mailbox = {path, uidValidity: UID_VALIDITY, exists: uids.length, uidNext: Math.max(0, ...uids) + 1};
		return {release: () => {}};
	}
	// Matches the subject for a search, as a server would the headers and text, and for an OR of
	// FROM and TO, the sender's and recipients' addresses, here all lowercase.
	async search(criteria: Criteria) {
		imap.searches.push(criteria);
		const words = criteria.gmraw ?? criteria.text;
		const below = criteria.uid ? Number(criteria.uid.split(':')[1]) : Infinity;
		const path = this.mailbox ? this.mailbox.path : '';
		// Without regard to case, as servers match headers.
		const has = (addresses: Address[] | undefined, wanted: string | undefined) => wanted !== undefined && (addresses ?? []).some(({address}) => address.includes(wanted.toLowerCase()));
		const involves = (message: Stored, one: Criteria) => has(message.from, one.from) || has(message.to, one.to);
		return box(path)
			.filter((message) => message.uid <= below && (!words || message.subject.includes(words)) && (!criteria.or || criteria.or.some((one) => involves(message, one))))
			.map((message) => message.uid);
	}
	// By position (`41:*`), or by UID with `{uid: true}` (`12,9,3`).
	async fetchAll(range: string, _fields: object, options?: {uid?: boolean}) {
		imap.fetches += 1;
		const path = this.mailbox ? this.mailbox.path : '';
		const stored = [...box(path)].sort((a, b) => a.uid - b.uid);
		const picked = options?.uid ? stored.filter((message) => range.split(',').includes(String(message.uid))) : stored.slice(Number(range.split(':')[0]) - 1);
		return picked.map((message) => ({
			uid: message.uid,
			flags: new Set(),
			internalDate: new Date(message.date),
			envelope: {subject: message.subject, from: message.from ?? [], to: message.to ?? [], cc: [{name: 'Jo Park', address: 'jo@example.com'}]},
		}));
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
	async append(path: string, raw: Buffer) {
		imap.calls.push(['append', path]);
		imap.appended.push(raw.toString('utf8'));
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

mock.module('../utils/secret-crypto', () => ({decryptSecret: () => Ok(JSON.stringify(credential))}));

function emails(): Collection {
	const integration = findIntegration('email');
	const found = integration && findCollection(integration, 'emails');
	if (!found) {
		throw new Error('No emails collection');
	}
	return found;
}

const target = {
	connection: {
		id: 'mail-1',
		integrationId: 'email',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		connectedById: 'user-1',
		account: 'alex@example.com',
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credential: 'v1.encrypted',
	},
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
	// One email in each folder, a day apart: the inbox's oldest, the draft's newest.
	imap.boxes = {
		INBOX: [{uid: 1, date: '2026-10-01T09:00:00Z', subject: 'In INBOX'}],
		'Sent Items': [{uid: 1, date: '2026-10-02T09:00:00Z', subject: 'In Sent Items'}],
		Drafts: [{uid: 1, date: '2026-10-03T09:00:00Z', subject: 'In Drafts'}],
	};
	imap.gmail = false;
	imap.logins = 0;
	imap.logouts = 0;
	imap.closes = 0;
	imap.fetches = 0;
	imap.searches = [];
	imap.calls = [];
	imap.appended = [];
	imap.message = {uid: 12, flags: new Set(), source};
	sendMail.mockReset();
	sendMail.mockResolvedValue({messageId: '<sent@proxy>'});
});

const EVERYTHING = {search: null, page: null, filter: null, parent: null};

// `count` emails, an hour apart from `start`, the newest with the highest UID.
function fill(count: number, start: string, subject = 'Note'): Stored[] {
	return Array.from({length: count}, (_, index) => ({uid: index + 1, date: new Date(Date.parse(start) + index * 3_600_000).toISOString(), subject: `${subject} ${index + 1}`}));
}

describe('emails', () => {
	test('one list of the inbox, drafts and sent mail, newest first, each saying where it is', async () => {
		const {emailConnector} = await import('./email-connector');
		const {records, nextPage} = (await emailConnector.list(target, EVERYTHING)).unwrap();

		expect(nextPage).toBeNull();
		expect(records.map((record) => [record.id, record.values.folder])).toEqual([
			[`drafts-${UID_VALIDITY}-1`, 'Draft'],
			[`sent-${UID_VALIDITY}-1`, 'Sent'],
			[`inbox-${UID_VALIDITY}-1`, 'Inbox'],
		]);
	});

	test('a server without a Sent folder lists the rest', async () => {
		imap.folders = imap.folders.filter((folder) => folder.specialUse !== '\\Sent');

		const {emailConnector} = await import('./email-connector');
		const {records} = (await emailConnector.list(target, EVERYTHING)).unwrap();

		expect(records.map((record) => record.values.folder)).toEqual(['Draft', 'Inbox']);
	});

	test('pages through every folder newest first, each email once', async () => {
		imap.boxes = {INBOX: fill(60, '2026-10-01T00:00:00Z'), Drafts: fill(3, '2026-10-02T10:30:00Z'), 'Sent Items': fill(10, '2026-10-01T20:30:00Z')};

		const {emailConnector} = await import('./email-connector');
		const first = (await emailConnector.list(target, EVERYTHING)).unwrap();
		const second = (await emailConnector.list(target, {...EVERYTHING, page: first.nextPage})).unwrap();

		expect(first.records).toHaveLength(50);
		expect(second.nextPage).toBeNull();
		const all = [...first.records, ...second.records];
		expect(new Set(all.map((record) => record.id)).size).toBe(73);
		const dates = all.map((record) => record.updatedAt);
		expect(dates).toEqual([...dates].sort().reverse());
	});

	test('a folder narrows the list to it', async () => {
		const {emailConnector} = await import('./email-connector');
		const {records} = (await emailConnector.list(target, {...EVERYTHING, filter: 'Draft', parent: null})).unwrap();

		expect(records.map((record) => record.values.folder)).toEqual(['Draft']);
	});

	test("searches with Gmail's own syntax on Gmail, and the words elsewhere", async () => {
		const {emailConnector} = await import('./email-connector');
		await emailConnector.list(target, {...EVERYTHING, search: 'from:sam'});
		imap.gmail = true;
		await emailConnector.list(target, {...EVERYTHING, search: 'from:sam'});

		expect(imap.searches.slice(0, 3)).toEqual([{text: 'from:sam'}, {text: 'from:sam'}, {text: 'from:sam'}]);
		expect(imap.searches.slice(3)).toEqual([{gmraw: 'from:sam'}, {gmraw: 'from:sam'}, {gmraw: 'from:sam'}]);
	});

	test('a page token from somewhere else is refused', async () => {
		const {emailConnector} = await import('./email-connector');
		const result = await emailConnector.list(target, {...EVERYTHING, page: 'nonsense'});

		expect(result.unwrapErr().kind).toBe('validation_error');
	});

	test('an email in the inbox has a status from its flags', async () => {
		imap.message?.flags.add('\\Flagged');

		const {emailConnector} = await import('./email-connector');
		const record = (await emailConnector.get(target, INBOX_EMAIL)).unwrap();

		expect(record.values.status).toBe('Unread, Flagged');
		expect(record.values.body).toBe('Sounds good, see you Thursday.');
	});

	test('an email opens with its Message-ID, as a reply names it', async () => {
		imap.message = {uid: 12, flags: new Set(), source: Buffer.from('From: sam@example.com\r\nSubject: Q3\r\nMessage-ID: <q3@example.com>\r\n\r\nHi\r\n')};

		const {emailConnector} = await import('./email-connector');
		const record = (await emailConnector.get(target, INBOX_EMAIL)).unwrap();

		expect(record.values.messageId).toBe('<q3@example.com>');
		expect(record.values.thread).toBeUndefined();
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

describe('attachments', () => {
	const withAttachments = Buffer.from(
		[
			'From: sam@example.com',
			'To: alex@example.com',
			'Subject: Q3 budget',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Budget attached.',
			'--b',
			'Content-Type: text/csv; name="Budget.csv"',
			'Content-Disposition: attachment; filename="Budget.csv"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('Item,Cost\r\nVenue,1200').toString('base64'),
			'--b--',
			'',
		].join('\r\n'),
	);

	function attachmentsTarget() {
		const integration = findIntegration('email');
		const collection = integration && findCollection(integration, 'attachments');
		if (!collection) {
			throw new Error('No attachments collection');
		}
		return {...target, collection};
	}

	test('an email opens with its attachments listed, and one is read by its number', async () => {
		imap.message = {uid: 12, flags: new Set(), source: withAttachments};

		const {emailAttachmentsConnector, emailConnector} = await import('./email-connector');
		const record = (await emailConnector.get(target, INBOX_EMAIL)).unwrap();
		const read = (await emailAttachmentsConnector.newCommands.read(attachmentsTarget(), {email: INBOX_EMAIL, attachment: '1'})).unwrap();

		expect(record.values.body).toBe('Budget attached.');
		expect(record.values.attachments).toBe('1. Budget.csv (text/csv, 21 B)');
		expect(read?.values).toMatchObject({email: INBOX_EMAIL, name: 'Budget.csv', content: 'Item,Cost\nVenue,1200'});
	});

	test('an email without attachments says so', async () => {
		const {emailAttachmentsConnector} = await import('./email-connector');
		const result = await emailAttachmentsConnector.newCommands.read(attachmentsTarget(), {email: INBOX_EMAIL, attachment: '1'});

		expect(result.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'This email has no attachments'});
	});
});

describe('emailConnector.findEmails', () => {
	test("searches the inbox in IMAP's own terms, newest first, at most as many as asked for", async () => {
		imap.boxes.INBOX = fill(6, '2026-10-01T09:00:00Z');
		const findInboxEmails = (await import('./email-connector')).emailConnector.findEmails;
		const [found = []] = (await findInboxEmails(target, [{from: 'sam', words: [['Note']], since: '2026-10-01'}], 3)).unwrap();

		expect(imap.opened).toBe('INBOX');
		// IMAP ANDs one object's keys, so each further condition goes in as NOT NOT (…).
		expect(imap.searches).toEqual([{from: 'sam', not: {not: {text: 'Note', not: {not: {since: '2026-10-01'}}}}}]);
		expect(found.map((record) => record.values.subject)).toEqual(['Note 6', 'Note 5', 'Note 4']);
		// With who was copied, which the widgets find people in.
		expect(found[0]?.values.cc).toBe('Jo Park <jo@example.com>');
	});

	test("searches in Gmail's syntax on Gmail, and everything without a search", async () => {
		const findInboxEmails = (await import('./email-connector')).emailConnector.findEmails;
		imap.gmail = true;
		await findInboxEmails(target, [{from: 'sam', words: [['Note']], since: null}], 3);
		await findInboxEmails(target, [{from: null, words: [], since: null}], 3);
		imap.gmail = false;
		await findInboxEmails(target, [{from: null, words: [], since: null}], 3);
		await findInboxEmails(target, [{from: null, involving: 'jacky', words: [], since: null}], 3);

		await findInboxEmails(target, [{from: null, words: [['flight', 'itinerary'], ['SFO']], since: null}], 3);

		expect(imap.searches).toEqual([
			{gmraw: 'from:sam Note'},
			{all: true},
			{all: true},
			{or: [{from: 'jacky'}, {to: 'jacky'}, {cc: 'jacky'}]},
			{or: [{text: 'flight'}, {text: 'itinerary'}], not: {not: {text: 'SFO'}}},
		]);
	});

	test('closes the connection when the search is given up on, rather than signing out after it', async () => {
		const findInboxEmails = (await import('./email-connector')).emailConnector.findEmails;
		const controller = new AbortController();
		const finding = findInboxEmails(target, [{from: 'sam', words: [], since: null}], 3, controller.signal);
		controller.abort();
		await finding;

		expect(imap.closes).toBe(1);
		expect(imap.logouts).toBe(0);
	});

	test('runs every search over one sign-in, answering what each found in the order asked', async () => {
		imap.boxes.INBOX = [
			{uid: 1, date: '2026-10-01T09:00:00Z', subject: 'Lunch with Jacky'},
			{uid: 2, date: '2026-10-02T09:00:00Z', subject: 'Notes for Sam'},
		];
		const findInboxEmails = (await import('./email-connector')).emailConnector.findEmails;
		const search = (words: string) => ({from: null, words: [[words]], since: null});
		const found = (await findInboxEmails(target, [search('Sam'), search('Jacky'), search('Robin')], 10)).unwrap();

		expect(imap.logins).toBe(1);
		expect(found.map((records) => records.map((record) => record.values.subject))).toEqual([['Notes for Sam'], ['Lunch with Jacky'], []]);
	});

	test('looks for several people in one search, and anyone it leaves short behind someone written to more on their own', async () => {
		const me = {address: 'me@example.com'};
		const jacky = {name: 'Jacky Doe', address: 'jacky@example.com'};
		const hugo = {name: 'Hugo Brandt', address: 'hugo@example.com'};
		const findInboxEmails = (await import('./email-connector')).emailConnector.findEmails;
		const involving = (someone: string) => ({from: null, involving: someone, words: [], since: null});
		const subjects = (found: Array<Array<{values: Record<string, string>}>>) => found.map((records) => records.map((record) => record.values.subject));
		const either = (someone: string) => [{from: someone}, {to: someone}, {cc: someone}];

		imap.boxes.INBOX = [
			{uid: 1, date: '2026-09-01T09:00:00Z', subject: 'From Hugo', from: [hugo], to: [me]},
			{uid: 2, date: '2026-10-01T09:00:00Z', subject: 'From Jacky', from: [jacky], to: [me]},
		];
		const together = (await findInboxEmails(target, [involving('jacky'), involving('HUGO')], 2)).unwrap();
		expect(imap.searches).toEqual([{or: [...either('jacky'), ...either('HUGO')]}]);
		expect(subjects(together)).toEqual([['From Jacky'], ['From Hugo']]);
		expect(imap.fetches).toBe(1);

		imap.searches = [];
		imap.fetches = 0;
		imap.boxes.INBOX = [
			{uid: 1, date: '2026-09-01T09:00:00Z', subject: 'From Hugo', from: [hugo], to: [me]},
			...Array.from({length: 10}, (_, index) => ({uid: index + 2, date: '2026-10-01T09:00:00Z', subject: `Jacky ${index + 1}`, from: [jacky], to: [me]})),
		];
		const crowded = (await findInboxEmails(target, [involving('jacky'), involving('hugo')], 2)).unwrap();
		expect(imap.searches).toEqual([{or: [...either('jacky'), ...either('hugo')]}, {or: either('hugo')}]);
		expect(subjects(crowded)).toEqual([['Jacky 10', 'Jacky 9'], ['From Hugo']]);
		expect(imap.logins).toBe(2);
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
		imap.gmail = true;

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

describe('emailConnector.reply', () => {
	const asked = Buffer.from(
		'From: Sam Lee <sam@example.com>\r\nReply-To: Planning <planning@example.com>\r\nTo: alex@example.com, Dana Cruz <dana@example.com>\r\nCc: Jo Park <jo@example.com>\r\nSubject: Q3 planning\r\nMessage-ID: <q3@example.com>\r\nReferences: <agenda@example.com>\r\n\r\nCan you make Thursday?\r\n',
	);

	function repliesTarget() {
		const integration = findIntegration('email');
		const collection = integration && findCollection(integration, 'replies');
		if (!collection) {
			throw new Error('No replies collection');
		}
		return {...target, collection};
	}

	test('sends a reply from the connected address, to where the email asks, in its thread, and files it in Sent', async () => {
		imap.message = {uid: 12, flags: new Set(), source: asked};
		const replyToMailbox = (await import('./email-connector')).emailConnector.reply;
		const written = (await replyToMailbox(target, INBOX_EMAIL, {body: 'Thursday works.', send: true, all: false})).unwrap();

		expect(written).toEqual({
			to: '"Planning" <planning@example.com>',
			cc: '',
			subject: 'Re: Q3 planning',
			inReplyTo: '<q3@example.com>',
			references: '<agenda@example.com> <q3@example.com>',
			// Sent over SMTP, it has no id among email but its Message-ID.
			id: expect.stringMatching(/^<[0-9a-f-]+@proxy>$/),
			thread: '',
		});
		expect(sendMail.mock.calls[0]?.[0]).toMatchObject({messageId: written.id});
		expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
			from: 'alex@example.com',
			to: '"Planning" <planning@example.com>',
			subject: 'Re: Q3 planning',
			text: 'Thursday works.',
			inReplyTo: '<q3@example.com>',
			references: '<agenda@example.com> <q3@example.com>',
		});
		expect(imap.calls).toEqual([['append', 'Sent Items']]);
		expect(imap.logins).toBe(1);
	});

	test('saves a reply in Drafts, keeping its thread', async () => {
		imap.message = {uid: 12, flags: new Set(), source: asked};
		const replyToMailbox = (await import('./email-connector')).emailConnector.reply;
		const written = (await replyToMailbox(target, INBOX_EMAIL, {body: 'Thursday works.', send: false, all: false})).unwrap();

		expect(written.id).toBe(`drafts-${UID_VALIDITY}-99`);
		expect(sendMail).not.toHaveBeenCalled();
		expect(imap.calls).toEqual([['append', 'Drafts']]);
		const draft = imap.appended[0]?.replace(/\r\n[ \t]+/g, ' ') ?? '';
		expect(draft).toContain('Subject: Re: Q3 planning');
		expect(draft).toContain('In-Reply-To: <q3@example.com>');
		expect(draft).toContain('References: <agenda@example.com> <q3@example.com>');
	});

	test('a reply to all also goes to whom the email went, and copies whom it copied, never the connected address', async () => {
		imap.message = {uid: 12, flags: new Set(), source: asked};
		const replyToMailbox = (await import('./email-connector')).emailConnector.reply;
		const written = (await replyToMailbox(target, INBOX_EMAIL, {body: 'Thursday works.', send: true, all: true})).unwrap();

		expect(written).toMatchObject({to: '"Planning" <planning@example.com>, "Dana Cruz" <dana@example.com>', cc: '"Jo Park" <jo@example.com>'});
		expect(sendMail.mock.calls[0]?.[0]).toMatchObject({to: '"Planning" <planning@example.com>, "Dana Cruz" <dana@example.com>', cc: '"Jo Park" <jo@example.com>'});
	});

	test('an email sent is replied to as well, to whom it went', async () => {
		imap.message = {uid: 12, flags: new Set(), source};
		const replyToMailbox = (await import('./email-connector')).emailConnector.reply;
		const written = (await replyToMailbox(target, `sent-${UID_VALIDITY}-12`, {body: 'Any news?', send: true, all: false})).unwrap();

		expect(imap.opened).toBe('Sent Items');
		expect(written).toMatchObject({to: 'sam@example.com', subject: 'Re: Q3 planning'});
	});

	test('replies to no draft, and to no email that isn’t there', async () => {
		const replyToMailbox = (await import('./email-connector')).emailConnector.reply;

		expect((await replyToMailbox(target, DRAFT, {body: 'x', send: true, all: false})).unwrapErr().kind).toBe('validation_error');
		expect((await replyToMailbox(target, `inbox-${UID_VALIDITY}-13`, {body: 'x', send: true, all: false})).unwrapErr().kind).toBe('not_found');
		expect(sendMail).not.toHaveBeenCalled();
	});

	test('agents reply as the replies collection, sent or saved in Drafts', async () => {
		imap.message = {uid: 12, flags: new Set(), source: asked};
		const {emailRepliesConnector} = await import('./email-connector');
		const sent = (await emailRepliesConnector.newCommands.send(repliesTarget(), {email: INBOX_EMAIL, body: 'Thursday works.', replyAll: 'No'})).unwrap();
		const drafted = (await emailRepliesConnector.newCommands.draft(repliesTarget(), {email: INBOX_EMAIL, body: 'Thursday works.', replyAll: 'Yes'})).unwrap();

		expect(sent?.values).toEqual({email: INBOX_EMAIL, body: 'Thursday works.', replyAll: 'No', to: '"Planning" <planning@example.com>', cc: '', subject: 'Re: Q3 planning'});
		expect(drafted).toMatchObject({id: `drafts-${UID_VALIDITY}-99`, values: {cc: '"Jo Park" <jo@example.com>'}});
		expect(imap.appended.at(-1)?.replace(/\r\n[ \t]+/g, ' ')).toContain('Cc: Jo Park <jo@example.com>');
	});
});
