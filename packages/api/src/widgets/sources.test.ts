import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listConnectionsWithCredential = mock();
const getConnectionWithCredential = mock();
const unavailableActions = mock((_connection: {id: string}): string[] => []);

// The Google client and the mail connectors read the environment on import, which tests don't have.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test'}}));
mock.module('@proxy/db/connection', () => ({listConnectionsWithCredential, getConnectionWithCredential, getConnectionCredential: mock(), updateConnectionCredential: mock()}));
mock.module('../connections/unavailable', () => ({
	unavailableActions,
	unavailableError: (_integration: unknown, actionId: string) => ({kind: 'validation_error', statusCode: 400, message: `not allowed: ${actionId}`}),
}));

function connection(id: string, integrationId: string) {
	return {id, integrationId, account: `${id}@example.com`, createdAt: new Date(0), tools: null, name: null, defaults: [], credential: 'sealed'};
}

beforeEach(() => {
	mock.clearAllMocks();
	unavailableActions.mockImplementation(() => []);
});

describe('findSources', () => {
	test('finds every connection with the collection whose sign-in covered reading it', async () => {
		listConnectionsWithCredential.mockResolvedValue(
			Ok([connection('vault', 'vault'), connection('work', 'google'), connection('home', 'google'), connection('imap', 'email'), connection('narrow', 'google')]),
		);
		unavailableActions.mockImplementation((stored) => (stored.id === 'narrow' ? ['readEvents', 'writeEvents'] : []));
		const {findSources} = await import('./sources');

		const calendars = (await findSources('org-1', 'events', 'list')).unwrap();
		expect(calendars.map((source) => source.connection.id)).toEqual(['work', 'home']);

		const mailboxes = (await findSources('org-1', 'emails', 'list')).unwrap();
		expect(mailboxes.map((source) => [source.connection.id, source.integration.id])).toEqual([
			['work', 'google'],
			['home', 'google'],
			['imap', 'email'],
			['narrow', 'google'],
		]);
	});

	test('asks for a command by its id: sending a new email', async () => {
		listConnectionsWithCredential.mockResolvedValue(Ok([connection('work', 'google'), connection('readonly', 'google')]));
		unavailableActions.mockImplementation((stored) => (stored.id === 'readonly' ? ['sendEmails'] : []));
		const {findSources} = await import('./sources');

		expect((await findSources('org-1', 'emails', 'sendNew')).unwrap().map((source) => source.connection.id)).toEqual(['work']);
	});
});

describe('requireWritable', () => {
	test("refuses guests where the sign-in didn't cover inviting them, and takes the event without them", async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(connection('work', 'google')));
		unavailableActions.mockImplementation(() => ['inviteGuests']);
		const {requireWritable} = await import('./sources');

		const refused = await requireWritable('org-1', 'work', 'events', 'create', ['title', 'start', 'guests']);
		expect(refused.unwrapErr()).toMatchObject({kind: 'validation_error', message: 'not allowed: inviteGuests'});

		const allowed = await requireWritable('org-1', 'work', 'events', 'create', ['title', 'start']);
		expect(allowed.unwrap().collection.id).toBe('events');
	});

	test('refuses a collection the connection has none of', async () => {
		getConnectionWithCredential.mockResolvedValue(Ok(connection('imap', 'email')));
		const {requireWritable} = await import('./sources');

		expect((await requireWritable('org-1', 'imap', 'events', 'create', [])).unwrapErr().kind).toBe('not_found');
	});
});
