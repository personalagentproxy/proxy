import {describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SlackOpeningFacts} from '@proxy/db/slack-openings';

mock.module('../observability/log', () => ({log: {debug: mock(), info: mock(), warn: mock(), error: mock()}, serializeError: mock(() => ({}))}));
mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const {slackOpening} = await import('./openings');

const member = {orgId: 'org-1', userId: 'user-1'};
const persona = {id: 'persona-1', name: 'Finance'};

// The facts of a member linked in Slack to a persona's app that is installed, its DM not known yet.
function facts(over: Partial<SlackOpeningFacts> = {}): SlackOpeningFacts {
	return {
		org: {experiments: ['slack'], insider: false},
		app: {id: 'app-1', botToken: 'enc:xoxb-bot', removedAt: null},
		slackUserId: 'U01',
		inOrganization: true,
		knownChannel: null,
		...over,
	};
}

function deps(read: SlackOpeningFacts | null, opened: Result<string, {kind: 'refused'; method: string; error: string; problems: []}> = Ok('D0NEW')) {
	return {facts: mock(async () => Ok(read)), openDm: mock(async () => opened)};
}

describe('where a thread opened in Slack goes', () => {
	test('is the sending thread’s DM where it lives in Slack with the same app, asking Slack nothing', async () => {
		const using = deps(facts({knownChannel: 'D0OLD'}));
		expect((await slackOpening(member, persona, {appId: 'app-1', channel: 'D0SENT'}, using)).unwrap()).toEqual({appId: 'app-1', channel: 'D0SENT'});
		expect(using.openDm).not.toHaveBeenCalled();
	});

	test('is the DM of another of the member’s threads with the app where one is known, as from another app’s thread or from Chat', async () => {
		const using = deps(facts({knownChannel: 'D0OLD'}));
		expect((await slackOpening(member, persona, {appId: 'app-9', channel: 'D0OTHER'}, using)).unwrap()).toEqual({appId: 'app-1', channel: 'D0OLD'});
		expect((await slackOpening(member, persona, null, using)).unwrap()).toEqual({appId: 'app-1', channel: 'D0OLD'});
		expect(using.openDm).not.toHaveBeenCalled();
	});

	test('is the DM Slack opens with the member’s Slack user otherwise, with the app’s bot', async () => {
		const using = deps(facts());
		expect((await slackOpening(member, persona, null, using)).unwrap()).toEqual({appId: 'app-1', channel: 'D0NEW'});
		expect(using.facts).toHaveBeenCalledWith(member, 'persona-1');
		expect(using.openDm).toHaveBeenCalledWith('xoxb-bot', 'U01');
	});

	test('is refused, saying so, where Slack won’t open the DM', async () => {
		const using = deps(facts(), Err({kind: 'refused', method: 'conversations.open', error: 'user_not_found', problems: []}));
		expect((await slackOpening(member, persona, null, using)).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: expect.stringContaining('Slack wouldn’t open your direct messages with Finance (user_not_found)'),
		});
	});

	const refused: Array<[string, SlackOpeningFacts | null, string]> = [
		['the organization has Slack off', facts({org: {experiments: [], insider: false}}), 'Slack isn’t on for your organization'],
		['the persona has no app', facts({app: null}), 'Finance isn’t in Slack'],
		['its app was removed', facts({app: {id: 'app-1', botToken: null, removedAt: new Date()}}), 'Finance isn’t in Slack'],
		['its app isn’t installed yet', facts({app: {id: 'app-1', botToken: null, removedAt: null}}), 'Finance isn’t in Slack'],
		['the member isn’t linked to Slack', facts({slackUserId: null}), 'You aren’t linked to Slack in Finance’s workspace yet'],
		['the member left the organization', facts({inOrganization: false}), 'You’re no longer in this organization'],
	];
	for (const [name, read, message] of refused) {
		test(`is refused where ${name}`, async () => {
			const using = deps(read);
			expect((await slackOpening(member, persona, null, using)).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining(message)});
			expect(using.openDm).not.toHaveBeenCalled();
		});
	}
});
