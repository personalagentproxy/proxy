import {z} from 'zod';

/**
 * What a message in a persona's app's DM comes to, with no Slack and no database in it: whether
 * it is a person saying something at all, what they said as they would have typed it in the app,
 * and, by who is speaking, whether it is taken up into a thread, or answered with a line asking
 * them to confirm who they are, or telling them why it isn't. The lines the app says in Slack are
 * here too, in Slack's own text format (https://docs.slack.dev/messaging/formatting-message-text).
 * events.ts and messages.ts act on what this says.
 */

/**
 * A `message` event as Slack sends it (https://docs.slack.dev/reference/events/message), or a
 * message as `conversations.replies` reads it back, which has no channel of its own: as much of it
 * as is read. A message with files has them in `files`, as a `file_share`.
 */
export const slackMessageSchema = z.looseObject({
	type: z.string(),
	channel: z.string().optional(),
	channel_type: z.string().optional(),
	user: z.string().optional(),
	text: z.string().optional(),
	ts: z.string(),
	thread_ts: z.string().optional(),
	subtype: z.string().optional(),
	bot_id: z.string().optional(),
	hidden: z.boolean().optional(),
	files: z.array(z.looseObject({})).optional(),
});

export type SlackMessage = z.infer<typeof slackMessageSchema>;

// The subtypes that are a person saying something: a message with files, a `/me` message, and a
// reply also sent to the DM. A plain message has none. Edits, deletions, bots' messages, the agent
// experience's own and every other subtype are not.
const SAID_SUBTYPES = new Set(['file_share', 'me_message', 'thread_broadcast']);

/** A person's message in the DM: who wrote it, where, the Slack thread it was said in (its root's `ts`, null at the top of the DM), what they said as they would have typed it in the app, and whether files came with it. */
export type SaidInSlack = {
	slackUserId: string;
	channel: string;
	ts: string;
	rootTs: string | null;
	text: string;
	files: boolean;
};

/**
 * The message as a person saying something in the app's DM, or null for anything else: a message
 * in any other kind of conversation, from the app's own bot or any other, hidden, an edit, a
 * deletion, or of another subtype; or with neither words nor files.
 */
export function readSlackMessage(message: SlackMessage, where: {channel: string; channelType: string | undefined; botUserId: string | null}): SaidInSlack | null {
	if (message.type !== 'message' || where.channelType !== 'im' || message.hidden === true) {
		return null;
	}
	if (message.bot_id !== undefined || message.user === undefined || message.user === where.botUserId) {
		return null;
	}
	if (message.subtype !== undefined && !SAID_SUBTYPES.has(message.subtype)) {
		return null;
	}
	const text = fromSlackText(message.text ?? '').trim();
	const files = (message.files ?? []).length > 0;
	if (text === '' && !files) {
		return null;
	}
	const rootTs = message.thread_ts !== undefined && message.thread_ts !== message.ts ? message.thread_ts : null;
	return {slackUserId: message.user, channel: where.channel, ts: message.ts, rootTs, text, files};
}

// Slack's escapes of its three control characters, `&` last, so `&amp;lt;` is `&lt;` as written.
function unescape(text: string): string {
	return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

// A link as Markdown, its label's brackets kept as words.
function markdownLink(label: string, url: string): string {
	return `[${label.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${url})`;
}

// Whether a link's label says nothing its address doesn't: the address, or the address without
// its scheme or a trailing slash, as Slack labels an address typed without `https://`.
function sameAsAddress(label: string, url: string): boolean {
	const bare = (address: string) =>
		address
			.replace(/^[a-z]+:\/\//i, '')
			.replace(/^mailto:/i, '')
			.replace(/\/$/, '');
	return label === url || bare(label) === bare(url);
}

// What one of Slack's `<…>` tokens stands for, as the person would have typed it: a link as its
// address, or as a Markdown link where its label says something else; a mention of a person, a
// channel or a group by its name where Slack gave one, otherwise by its id; `@here` and the like;
// a date as its fallback text.
function fromToken(token: string): string {
	const bar = token.indexOf('|');
	const target = unescape(bar === -1 ? token : token.slice(0, bar));
	const label = bar === -1 ? null : unescape(token.slice(bar + 1));
	if (target.startsWith('@')) {
		return `@${label ?? target.slice(1)}`;
	}
	if (target.startsWith('#')) {
		return `#${label ?? target.slice(1)}`;
	}
	if (target.startsWith('!')) {
		return fromCommand(target.slice(1), label);
	}
	const address = target.toLowerCase().startsWith('mailto:') ? target.slice('mailto:'.length) : target;
	if (label === null || label === '' || sameAsAddress(label, target)) {
		return address;
	}
	return markdownLink(label, target);
}

// `<!here>`, `<!channel>`, `<!everyone>`, a group's `<!subteam^ID|@handle>`, a date's
// `<!date^…|fallback>`; anything else Slack writes this way, by its label or its name.
function fromCommand(command: string, label: string | null): string {
	const [name = '', id] = command.split('^');
	if (name === 'date') {
		return label ?? '';
	}
	if (name === 'subteam') {
		return label ?? `@${id ?? ''}`;
	}
	return label ?? `@${name}`;
}

/**
 * A message's text in Slack's format as the member would have typed it in the app: Slack's
 * `<…>` tokens turned into what they stand for (`fromToken`), and `&amp;`, `&lt;`, `&gt;` back
 * into the characters. Bold, italics and code are left as Slack writes them.
 */
export function fromSlackText(text: string): string {
	let out = '';
	let at = 0;
	for (const match of text.matchAll(/<([^<>]*)>/g)) {
		out += unescape(text.slice(at, match.index)) + fromToken(match[1] ?? '');
		at = match.index + match[0].length;
	}
	return out + unescape(text.slice(at));
}

/** Text of ours as it goes into a line in Slack's format: its control characters escaped. */
export function toSlackText(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Who is speaking: a Slack user linked to nobody in the organization, linked to someone no longer in it, or linked to a member. */
export type SlackSpeaker = {kind: 'unknown'} | {kind: 'gone'} | {kind: 'member'; userId: string};

/**
 * What follows a message: a line asking its writer to confirm who they are, with a link to do it,
 * the message taken up once they have; a line alone; the message taken up in the member's chat,
 * with a line after where its files were left out; or nothing at all.
 */
export type SlackMessagePlan = {kind: 'confirm'} | {kind: 'say'; line: string} | {kind: 'take_up'; userId: string; text: string; filesLine: string | null} | {kind: 'leave'};

// What a member may be asked to reply in a thread, when its agent behaves oddly, for the thread's
// id: the Chat page catches it and never sends it (web pages/chat-thread.tsx), so a reply of it in
// a Slack thread isn't taken to the agent either.
const TRACE_COMMAND = '/trace';

export const FILES_LEFT_LINE = 'I can’t read files yet, so I took up your words without them.';
export const FILES_ONLY_LINE = 'I can’t read files yet. Say what you need in words.';
export const ELSEWHERE_LINE = 'This thread was started as someone else in Personal Agent Proxy. Start a new message to talk as you.';

/** The line asking a Slack user linked to nobody to confirm who they are, with the link to do it. */
export function confirmLine(url: string): string {
	return `Confirm who you are in Personal Agent Proxy, and I’ll take this up: <${url}|Confirm>`;
}

/** The line for a Slack user linked to someone no longer in the organization. */
export function goneLine(orgName: string): string {
	return `You’re no longer in ${toSlackText(orgName)} in Personal Agent Proxy, so I can’t take this up.`;
}

/**
 * What follows what was said, by who is speaking: a reply of /trace alone is left, as the Chat
 * page leaves it; files alone are never taken up, and are answered so; someone no longer in the
 * organization is told so; a Slack user linked to nobody is asked to confirm who they are; a
 * member's words are taken up, without the files.
 */
export function planFor(said: SaidInSlack, speaker: SlackSpeaker, orgName: string): SlackMessagePlan {
	if (said.rootTs !== null && !said.files && said.text === TRACE_COMMAND) {
		return {kind: 'leave'};
	}
	if (speaker.kind === 'gone') {
		return {kind: 'say', line: goneLine(orgName)};
	}
	if (said.text === '') {
		return {kind: 'say', line: FILES_ONLY_LINE};
	}
	if (speaker.kind === 'unknown') {
		return {kind: 'confirm'};
	}
	return {kind: 'take_up', userId: speaker.userId, text: said.text, filesLine: said.files ? FILES_LEFT_LINE : null};
}

/** What taking a message up came to (`takeUpSlackMessage` in @proxy/db/slack-messages), as far as what the app says after. */
export type TakenUp = 'opened' | 'continued' | 'taken_already' | 'elsewhere' | 'no_chat';

/** The line said after a message was taken up, where there is one: its files left out, or its Slack thread another member's. Nothing for one taken up before. */
export function lineAfter(plan: {filesLine: string | null}, taken: TakenUp): string | null {
	if (taken === 'elsewhere') {
		return ELSEWHERE_LINE;
	}
	if (taken === 'opened' || taken === 'continued') {
		return plan.filesLine;
	}
	return null;
}

/** The Slack thread a line answering what was said goes in: the one it was said in, or the one under it. */
export function threadOf(said: SaidInSlack): string {
	return said.rootTs ?? said.ts;
}
