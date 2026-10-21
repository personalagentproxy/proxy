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

const ALL_SCOPES = [
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/gmail.send',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/documents',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/presentations',
	'https://www.googleapis.com/auth/contacts',
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
		const calendar = ['readEvents', 'writeEvents', 'respondEvents', 'inviteGuests'];

		expect(unavailableActions(google(ALL_SCOPES.filter((scope) => !scope.endsWith('/calendar.events'))))).toEqual(calendar);
		expect(unavailableActions(google(ALL_SCOPES.filter((scope) => !scope.endsWith('/calendar.calendarlist.readonly'))))).toEqual(calendar);
	});

	test('a Google sign-in from before Calendar and Contacts joined leaves their actions out', async () => {
		const {unavailableActions} = await import('./unavailable');
		const before = ALL_SCOPES.filter((scope) => !/\/(calendar\.|contacts)/.test(scope));

		expect(unavailableActions(google(before))).toEqual(['readEvents', 'writeEvents', 'respondEvents', 'inviteGuests', 'readContacts', 'writeContacts']);
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
