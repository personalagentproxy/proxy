import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {findCollection, findIntegration} from '@proxy/integrations';

const requireWritable = mock();
const requireReadable = mock();
const reply = mock();
const replierFor = mock((): typeof reply | null => reply);
const afterWrite = mock(async () => {});
const create = mock();
const sendNew = mock();
const get = mock();
const update = mock();

// The Google client and the mail connectors read the environment on import, which tests don't have.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test'}}));
mock.module('./sources', () => ({requireWritable, requireReadable, findSources: mock(), summarize: mock()}));
mock.module('./mail-replies', () => ({replierFor}));
mock.module('./writes', () => ({afterWrite}));
mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
}));

const events = findCollection(findIntegration('google') ?? {collections: []}, 'events');
const source = {connection: {id: 'work'}, collection: events, connector: {create, get, update, newCommands: {sendNew}}};

function request(body: unknown) {
	return {user: {userId: 'user-1'}, body} as never;
}

const event = {connectionId: 'work', calendarId: 'team', title: ' Lunch ', start: '2026-10-15T13:00:00+02:00', end: '2026-10-15T13:30:00+02:00', location: 'Nopa'};

beforeEach(() => {
	mock.clearAllMocks();
	requireWritable.mockResolvedValue(Ok(source));
	requireReadable.mockResolvedValue(Ok(source));
	reply.mockResolvedValue(Ok({to: 'Sam <sam@example.com>', cc: '', subject: 'Re: Invoice', inReplyTo: '<a@example.com>', references: '<a@example.com>', id: 'm8', thread: 't1'}));
	create.mockResolvedValue(Ok({id: 'team:e1', values: {title: 'Lunch'}, updatedAt: '', url: 'https://calendar.google.com/e1'}));
	sendNew.mockResolvedValue(Ok(null));
});

describe('handleCreateEventRoute', () => {
	test('makes the event in the calendar picked through its connector, logs it and keeps the calendar', async () => {
		const {handleCreateEventRoute} = await import('./new-event');

		const made = await handleCreateEventRoute(request({...event, guests: ['jacky@example.com', 'sam@example.com']}));
		expect(made.unwrap()).toEqual({title: 'Lunch', link: 'https://calendar.google.com/e1'});
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'events', 'create', ['title', 'start', 'end', 'location', 'guests']);
		expect(create).toHaveBeenCalledWith(source, {title: 'Lunch', start: event.start, end: event.end, location: 'Nopa', guests: 'jacky@example.com, sam@example.com'}, 'team');
		expect(afterWrite).toHaveBeenCalledWith({viewer: expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), source, action: 'create', title: 'Lunch', parent: 'team'});
	});

	test("doesn't ask for Invite guests for an event without them", async () => {
		const {handleCreateEventRoute} = await import('./new-event');

		await handleCreateEventRoute(request(event));
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'events', 'create', ['title', 'start', 'end', 'location']);
	});

	test('writes nothing and logs nothing when refused', async () => {
		requireWritable.mockResolvedValue(Err(ApiErr.validationError("Google didn't allow Invite guests at sign-in.")));
		const {handleCreateEventRoute} = await import('./new-event');

		expect((await handleCreateEventRoute(request({...event, guests: ['jacky@example.com']}))).unwrapErr().kind).toBe('validation_error');
		expect(create).not.toHaveBeenCalled();
		expect(afterWrite).not.toHaveBeenCalled();
	});

	test('refuses times without an offset and guests that are no addresses', async () => {
		const {handleCreateEventRoute} = await import('./new-event');

		expect((await handleCreateEventRoute(request({...event, start: '2026-10-15T13:00'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreateEventRoute(request({...event, guests: ['Jacky']}))).unwrapErr().kind).toBe('parse_error');
		expect(requireWritable).not.toHaveBeenCalled();
	});
});

describe('handleWriteEmailRoute', () => {
	const email = {connectionId: 'work', to: ['jacky@example.com'], subject: 'Lunch', body: 'Tuesday?'};

	test('sends a new email with the mailbox’s own command, logged as sent', async () => {
		const {handleWriteEmailRoute} = await import('./emails');

		expect((await handleWriteEmailRoute(request({...email, send: true}))).unwrap()).toEqual({sent: true});
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'emails', 'sendNew', ['to', 'subject', 'body']);
		expect(sendNew).toHaveBeenCalledWith(source, {to: 'jacky@example.com', subject: 'Lunch', body: 'Tuesday?'});
		expect(create).not.toHaveBeenCalled();
		expect(afterWrite).toHaveBeenCalledWith(expect.objectContaining({action: 'sendNew', title: 'Lunch', parent: null}));
	});

	test('saves a draft as creating an email', async () => {
		const {handleWriteEmailRoute} = await import('./emails');

		expect((await handleWriteEmailRoute(request({...email, send: false}))).unwrap()).toEqual({sent: false});
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'emails', 'create', ['to', 'subject', 'body']);
		expect(create).toHaveBeenCalledWith(source, {to: 'jacky@example.com', subject: 'Lunch', body: 'Tuesday?'}, null);
		expect(sendNew).not.toHaveBeenCalled();
	});

	test('takes no email without a recipient', async () => {
		const {handleWriteEmailRoute} = await import('./emails');

		expect((await handleWriteEmailRoute(request({...email, to: [], send: true}))).unwrapErr().kind).toBe('parse_error');
	});
});

describe('handleReplyEmailRoute', () => {
	const answer = {connectionId: 'work', emailId: 'm1', body: 'Paid this morning.'};

	test('sends a reply to the email through its mailbox, logged as sent under the reply’s subject', async () => {
		const {handleReplyEmailRoute} = await import('./emails');

		expect((await handleReplyEmailRoute(request({...answer, send: true}))).unwrap()).toEqual({sent: true});
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'emails', 'sendNew', ['to', 'subject', 'body']);
		expect(requireReadable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'emails');
		expect(reply).toHaveBeenCalledWith(source, 'm1', {body: 'Paid this morning.', send: true, all: false});
		// The mailbox is the email's, so none is picked for the next new email.
		expect(afterWrite).toHaveBeenCalledWith({viewer: expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), source, action: 'sendNew', title: 'Re: Invoice', parent: undefined});
	});

	test('saves a reply as a draft as creating an email', async () => {
		const {handleReplyEmailRoute} = await import('./emails');

		expect((await handleReplyEmailRoute(request({...answer, send: false}))).unwrap()).toEqual({sent: false});
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'emails', 'create', ['to', 'subject', 'body']);
		expect(reply).toHaveBeenCalledWith(source, 'm1', {body: 'Paid this morning.', send: false, all: false});
	});

	test('replies through no mailbox it can’t read, nor one that can’t reply, and logs nothing then', async () => {
		const {handleReplyEmailRoute} = await import('./emails');

		requireReadable.mockResolvedValueOnce(Err(ApiErr.forbidden()));
		expect((await handleReplyEmailRoute(request({...answer, send: true}))).unwrapErr().kind).toBe('forbidden');
		replierFor.mockReturnValueOnce(null);
		expect((await handleReplyEmailRoute(request({...answer, send: true}))).unwrapErr().kind).toBe('forbidden');
		expect(reply).not.toHaveBeenCalled();
		expect(afterWrite).not.toHaveBeenCalled();
	});
});

describe('handleEditEventRoute', () => {
	const lunch = {
		id: 'team:e1',
		values: {
			title: 'Lunch',
			kind: 'Event',
			start: '2026-10-15T13:00:00+02:00',
			end: '2026-10-15T13:30:00+02:00',
			location: 'Nopa',
			guests: 'jacky@example.com',
			description: 'Agenda',
			organizer: '',
			answers: 'Jacky <jacky@example.com>: Accepted',
		},
		updatedAt: '',
	};
	const moved = {connectionId: 'work', calendarId: 'team', eventId: 'e1', start: '2026-10-16T15:00:00+02:00', end: '2026-10-16T15:30:00+02:00'};

	beforeEach(() => {
		get.mockResolvedValue(Ok(lunch));
		update.mockResolvedValue(Ok({...lunch, values: {...lunch.values, start: moved.start, end: moved.end}, url: 'https://calendar.google.com/e1'}));
	});

	test('changes only what is given, the rest as the event is, through its connector', async () => {
		const {handleEditEventRoute} = await import('./edit-event');

		const changed = await handleEditEventRoute(request(moved));
		expect(changed.unwrap()).toEqual({title: 'Lunch', link: 'https://calendar.google.com/e1'});
		expect(get).toHaveBeenCalledWith(source, 'team:e1');
		expect(update).toHaveBeenCalledWith(source, 'team:e1', {title: 'Lunch', start: moved.start, end: moved.end, location: 'Nopa', guests: 'jacky@example.com', description: 'Agenda'}, lunch);
		// Its guests are told, which needs Invite guests too.
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'events', 'update', ['start', 'end']);
		expect(requireWritable).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'work', 'events', 'update', ['guests']);
		// A change picks no calendar for the next new event.
		expect(afterWrite).toHaveBeenCalledWith({viewer: expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), source, action: 'update', title: 'Lunch', parent: undefined});
	});

	test('writes the guests as given', async () => {
		const {handleEditEventRoute} = await import('./edit-event');

		await handleEditEventRoute(request({connectionId: 'work', calendarId: 'team', eventId: 'e1', guests: ['jacky@example.com', 'hugo@example.com']}));
		expect(requireWritable).toHaveBeenCalledTimes(1);
		expect(update.mock.calls[0]?.[2]).toMatchObject({guests: 'jacky@example.com, hugo@example.com', start: lunch.values.start});
	});

	test('changes no event someone else organizes, and no calendar', async () => {
		const {handleEditEventRoute} = await import('./edit-event');

		get.mockResolvedValueOnce(Ok({...lunch, values: {...lunch.values, organizer: 'Sam Lee <sam@example.com>'}}));
		expect((await handleEditEventRoute(request(moved))).unwrapErr()).toEqual(ApiErr.validationError('Only an event you organize can be changed here'));
		get.mockResolvedValueOnce(Ok({...lunch, values: {...lunch.values, kind: 'Calendar'}}));
		expect((await handleEditEventRoute(request(moved))).unwrapErr().kind).toBe('not_found');
		expect(update).not.toHaveBeenCalled();
		expect(afterWrite).not.toHaveBeenCalled();
	});
});
