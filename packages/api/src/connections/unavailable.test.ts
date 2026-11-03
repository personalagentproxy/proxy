import {describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

const warn = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn, error: mock()},
	serializeError: mock(() => ({})),
}));

// Readable stand-ins for encryption; a credential stored under another key won't decrypt.
mock.module('../utils/secret-crypto', () => ({
	decryptSecret: (stored: string): Result<string, ApiError> => (stored.startsWith('enc:') ? Ok(stored.slice('enc:'.length)) : Err(ApiErr.internalError(new Error('Unreadable secret')))),
}));

// Of the integrations' modules, Google's partial consent alone, read from its credential.
const {unavailableGoogleConnectionActions} = await import('./google/unavailable');

mock.module('./integrations', () => ({
	apiIntegration: (id: string) => (id === 'google' ? {id, connectors: {}, unavailableActions: unavailableGoogleConnectionActions} : undefined),
}));

const ALL_SCOPES = [
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/gmail.send',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/calendar.events.freebusy',
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/contacts',
	'https://www.googleapis.com/auth/contacts.other.readonly',
	'https://www.googleapis.com/auth/tasks',
];

function google(scopes: string[]) {
	const credential = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes, email: 'alex@example.com'};
	return {id: 'google-1', integrationId: 'google', credential: `enc:${JSON.stringify(credential)}`};
}

describe('unavailableActions', () => {
	test('a Google sign-in that granted every scope covers every action', async () => {
		const {unavailableActions} = await import('./unavailable');

		expect(unavailableActions(google(ALL_SCOPES))).toEqual([]);
	});

	test('a Google sign-in without Drive leaves every files action out', async () => {
		const {unavailableActions} = await import('./unavailable');

		expect(unavailableActions(google(ALL_SCOPES.filter((scope) => !scope.endsWith('/drive'))))).toEqual(['readFiles', 'createFiles', 'editFiles', 'trashFiles']);
	});

	test('a Google sign-in with only gmail.send leaves every Gmail action but Send out', async () => {
		const {unavailableActions} = await import('./unavailable');

		const withoutModify = ALL_SCOPES.filter((scope) => !scope.endsWith('/gmail.modify'));
		expect(unavailableActions(google(withoutModify))).toEqual(['readEmails', 'markEmails', 'flagEmails', 'archiveEmails', 'writeEmails', 'trashEmails']);
		expect(unavailableActions(google(withoutModify.filter((scope) => !scope.endsWith('/gmail.send'))))).toContain('sendEmails');
	});

	test('Calendar needs both its scopes, its events and the list of calendars holding them', async () => {
		const {unavailableActions} = await import('./unavailable');
		const events = ['readEvents', 'writeEvents', 'respondEvents', 'inviteGuests'];

		expect(unavailableActions(google(ALL_SCOPES.filter((scope) => !scope.endsWith('/calendar.events'))))).toEqual(events);
		expect(unavailableActions(google(ALL_SCOPES.filter((scope) => !scope.endsWith('/calendar.calendarlist.readonly'))))).toEqual([
			'readEvents',
			'readAvailability',
			'writeEvents',
			'respondEvents',
			'inviteGuests',
		]);
	});

	test('who is free, other contacts and tasks each need a scope of their own', async () => {
		const {unavailableActions} = await import('./unavailable');
		const without = (name: string) => google(ALL_SCOPES.filter((scope) => !scope.endsWith(`/${name}`)));

		expect(unavailableActions(without('calendar.events.freebusy'))).toEqual(['readAvailability']);
		expect(unavailableActions(without('contacts.other.readonly'))).toEqual(['readOtherContacts']);
		expect(unavailableActions(without('tasks'))).toEqual(['readTasks', 'writeTasks']);
	});

	test('a Google sign-in from before Calendar, Contacts and Tasks joined leaves their actions out', async () => {
		const {unavailableActions} = await import('./unavailable');
		const before = ALL_SCOPES.filter((scope) => !/\/(calendar\.|contacts|tasks)/.test(scope));

		expect(unavailableActions(google(before))).toEqual([
			'readEvents',
			'readAvailability',
			'writeEvents',
			'respondEvents',
			'inviteGuests',
			'readContacts',
			'readOtherContacts',
			'writeContacts',
			'readTasks',
			'writeTasks',
		]);
	});

	test('a Google sign-in from before who is free, other contacts and tasks joined leaves only those out, whatever else it granted', async () => {
		const {unavailableActions} = await import('./unavailable');
		const before = [
			...ALL_SCOPES.filter((scope) => !/\/(calendar\.events\.freebusy|contacts\.other\.readonly|tasks)$/.test(scope)),
			'https://www.googleapis.com/auth/documents',
			'https://www.googleapis.com/auth/spreadsheets',
			'https://www.googleapis.com/auth/presentations',
		];

		expect(unavailableActions(google(before))).toEqual(['readAvailability', 'readOtherContacts', 'readTasks', 'writeTasks']);
	});

	test('every other integration covers all its actions, whatever its credential', async () => {
		const {unavailableActions} = await import('./unavailable');

		expect(unavailableActions({id: 'email-1', integrationId: 'email', credential: 'v1.unreadable'})).toEqual([]);
		expect(unavailableActions({id: 'vault-1', integrationId: 'vault', credential: null})).toEqual([]);
	});

	test("a Google credential that won't decrypt or read covers no action, and is logged", async () => {
		const {findIntegration} = await import('@proxy/integrations');
		const {unavailableActions} = await import('./unavailable');
		const every = findIntegration('google')?.actions.map((action) => action.id);

		for (const credential of ['v1.other-key', 'enc:{"accessToken":1}', 'enc:not json', null]) {
			expect(unavailableActions({id: 'google-1', integrationId: 'google', credential})).toEqual(every ?? []);
		}
		expect(warn).toHaveBeenCalledWith('A Google credential could not be read', {connectionId: 'google-1'});
	});
});

describe('refuseUnavailable', () => {
	test('refuses turning an unavailable action on, not off or back to the default', async () => {
		const {findIntegration} = await import('@proxy/integrations');
		const {refuseUnavailable} = await import('./unavailable');
		const integration = findIntegration('google');
		if (!integration) {
			throw new Error('No Google integration');
		}

		expect(refuseUnavailable(integration, ['readFiles'], {readFiles: true}).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: "Google didn't allow Read files at sign-in. Sign in to Google again to allow it.",
		});
		expect(refuseUnavailable(integration, ['readFiles'], {readFiles: false}).isOk()).toBe(true);
		expect(refuseUnavailable(integration, ['readFiles'], {readFiles: null}).isOk()).toBe(true);
		expect(refuseUnavailable(integration, [], {readFiles: true}).isOk()).toBe(true);
	});
});
