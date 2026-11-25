import {describe, expect, test} from 'bun:test';

import {
	confirmLine,
	ELSEWHERE_LINE,
	FILES_LEFT_LINE,
	FILES_ONLY_LINE,
	fromSlackText,
	goneLine,
	lineAfter,
	planFor,
	readSlackMessage,
	type SaidInSlack,
	type SlackMessage,
	type SlackSpeaker,
	threadOf,
	toSlackText,
} from './message-rules';

const where = {channel: 'D01', channelType: 'im', botUserId: 'U0BOT'};

const message = (fields: Partial<SlackMessage> = {}): SlackMessage => ({
	type: 'message',
	channel: 'D01',
	channel_type: 'im',
	user: 'U01',
	text: 'Book the train to Lyon',
	ts: '1700000000.000100',
	...fields,
});

const said = (fields: Partial<SaidInSlack> = {}): SaidInSlack => ({slackUserId: 'U01', channel: 'D01', ts: '1700000000.000100', rootTs: null, text: 'Book the train to Lyon', files: false, ...fields});

describe('what a message in the app’s DM is', () => {
	const cases: Array<[string, SlackMessage, Partial<typeof where>, SaidInSlack | null]> = [
		['a message at the top of the DM', message(), {}, said()],
		['a reply in a Slack thread, under its root', message({ts: '1700000000.000200', thread_ts: '1700000000.000100'}), {}, said({ts: '1700000000.000200', rootTs: '1700000000.000100'})],
		['a root message Slack marks with its own thread_ts', message({thread_ts: '1700000000.000100'}), {}, said()],
		['a reply also sent to the DM', message({subtype: 'thread_broadcast', ts: '1700000000.000300', thread_ts: '1700000000.000100'}), {}, said({ts: '1700000000.000300', rootTs: '1700000000.000100'})],
		['a /me message', message({subtype: 'me_message', text: 'is on the train'}), {}, said({text: 'is on the train'})],
		['the app’s own bot, by its bot id', message({bot_id: 'B0BOT', user: 'U0BOT'}), {}, null],
		['the app’s own bot, by its user', message({user: 'U0BOT'}), {}, null],
		[
			'the root message the app posted at the top of the DM for a thread opened in Slack, as it comes back',
			message({
				bot_id: 'B0BOT',
				user: 'U0BOT',
				text: 'Your message, passed on from “Pricing review with Dana”:\n&gt; Draft the renewal',
				metadata: {event_type: 'thread_opened', event_payload: {place: 'place-1'}},
			}),
			{},
			null,
		],
		['the same, as a bot message with no user', message({subtype: 'bot_message', bot_id: 'B0BOT', user: undefined}), {}, null],
		[
			'a reply under the root message the app posted',
			message({ts: '1700000000.000400', thread_ts: '1700000000.000300', text: 'Make it shorter'}),
			{},
			said({ts: '1700000000.000400', rootTs: '1700000000.000300', text: 'Make it shorter'}),
		],
		['another bot', message({subtype: 'bot_message', bot_id: 'B02', user: undefined}), {}, null],
		['an edit', message({subtype: 'message_changed', user: undefined, hidden: true}), {}, null],
		['a deletion', message({subtype: 'message_deleted', user: undefined, hidden: true}), {}, null],
		['the agent experience’s own thread', message({subtype: 'assistant_app_thread'}), {}, null],
		['a message in a channel', message(), {channelType: 'channel'}, null],
		['another kind of event', message({type: 'reaction_added'}), {}, null],
		['nothing said', message({text: '  '}), {}, null],
		['files with words', message({subtype: 'file_share', text: 'Here is the invoice', files: [{id: 'F01'}]}), {}, said({text: 'Here is the invoice', files: true})],
		['files alone', message({subtype: 'file_share', text: '', files: [{id: 'F01'}]}), {}, said({text: '', files: true})],
	];

	test.each(cases)('%s', (_name, input, override, expected) => {
		expect(readSlackMessage(input, {...where, ...override})).toEqual(expected);
	});
});

describe('Slack’s text as the member would have typed it', () => {
	const cases: Array<[string, string, string]> = [
		['plain words', 'Book the train', 'Book the train'],
		['the entities', 'a &lt; b &amp;&amp; c &gt; d, &amp;lt; as written', 'a < b && c > d, &lt; as written'],
		['a bare link', 'see <https://example.com/a?b=1&amp;c=2>', 'see https://example.com/a?b=1&c=2'],
		['a link labelled with its address', '<https://example.com|example.com>', 'https://example.com'],
		['a link labelled with words', 'the <https://example.com/plan|travel plan>', 'the [travel plan](https://example.com/plan)'],
		['a label with brackets', '<https://example.com|[draft] plan>', '[\\[draft\\] plan](https://example.com)'],
		['an email address', 'write <mailto:dana@example.com|dana@example.com>', 'write dana@example.com'],
		['a person by id', 'ask <@U02> first', 'ask @U02 first'],
		['a person by name', 'ask <@U02|dana>', 'ask @dana'],
		['a channel', 'in <#C01|travel> or <#C02>', 'in #travel or #C02'],
		['@here and the like', '<!here> <!channel> <!everyone>', '@here @channel @everyone'],
		['a group', '<!subteam^S01|@finance> and <!subteam^S02>', '@finance and @S02'],
		['a date', 'by <!date^1700000000^{date_short}|Nov 14>', 'by Nov 14'],
		['bold and code left as they are', '*now* and `ls`', '*now* and `ls`'],
	];

	test.each(cases)('%s', (_name, input, expected) => {
		expect(fromSlackText(input)).toBe(expected);
	});

	test('escapes our own text for a line', () => {
		expect(toSlackText('R&D <team>')).toBe('R&amp;D &lt;team&gt;');
	});
});

describe('what follows a message, by who is speaking', () => {
	const member: SlackSpeaker = {kind: 'member', userId: 'user-1'};
	const cases: Array<[string, SaidInSlack, SlackSpeaker, ReturnType<typeof planFor>]> = [
		['a member’s words are taken up', said(), member, {kind: 'take_up', userId: 'user-1', text: 'Book the train to Lyon', filesLine: null}],
		['a member’s words with files: the words, and a line', said({files: true}), member, {kind: 'take_up', userId: 'user-1', text: 'Book the train to Lyon', filesLine: FILES_LEFT_LINE}],
		['a member’s files alone: a line, nothing opened', said({text: '', files: true}), member, {kind: 'say', line: FILES_ONLY_LINE}],
		['a Slack user linked to nobody is asked to confirm', said(), {kind: 'unknown'}, {kind: 'confirm'}],
		['files alone from a Slack user linked to nobody: the files line', said({text: '', files: true}), {kind: 'unknown'}, {kind: 'say', line: FILES_ONLY_LINE}],
		['someone no longer in the organization is told so', said(), {kind: 'gone'}, {kind: 'say', line: goneLine('Northwind & Co')}],
		['a reply of /trace is left, as the Chat page leaves it', said({ts: '1700000000.000200', rootTs: '1700000000.000100', text: '/trace'}), member, {kind: 'leave'}],
		['a message of /trace at the top of the DM opens a thread, as in the Chat page', said({text: '/trace'}), member, {kind: 'take_up', userId: 'user-1', text: '/trace', filesLine: null}],
	];

	test.each(cases)('%s', (_name, input, speaker, expected) => {
		expect(planFor(input, speaker, 'Northwind & Co')).toEqual(expected);
	});

	test('the lines after taking one up: files left out, or a Slack thread of another member’s; nothing for one taken before', () => {
		expect(lineAfter({filesLine: FILES_LEFT_LINE}, 'opened')).toBe(FILES_LEFT_LINE);
		expect(lineAfter({filesLine: null}, 'continued')).toBeNull();
		expect(lineAfter({filesLine: FILES_LEFT_LINE}, 'taken_already')).toBeNull();
		expect(lineAfter({filesLine: null}, 'elsewhere')).toBe(ELSEWHERE_LINE);
	});

	test('answers in the Slack thread the message was said in, or under it', () => {
		expect(threadOf(said())).toBe('1700000000.000100');
		expect(threadOf(said({ts: '1700000000.000200', rootTs: '1700000000.000100'}))).toBe('1700000000.000100');
	});

	test('the lines, in Slack’s format', () => {
		expect(confirmLine('https://proxy.example.com/confirm-slack/abc.def')).toBe(
			'Confirm who you are in Personal Agent Proxy, and I’ll take this up: <https://proxy.example.com/confirm-slack/abc.def|Confirm>',
		);
		expect(goneLine('Northwind & Co')).toBe('You’re no longer in Northwind &amp; Co in Personal Agent Proxy, so I can’t take this up.');
	});
});
