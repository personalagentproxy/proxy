import {Result} from 'ts-results-es';
import {z} from 'zod';

import {type FetchError, formatFetchError, httpRequest} from '@proxy/utils';

import type {EnvLabel} from './types';

/**
 * Posts to the team's Slack: a sign-up to one channel, an alert to another, each as a message
 * with a title, a body and the context as fields. Without a bot token, or without the channel, a
 * message is written to stdout in development and dropped in production, so a server runs
 * without Slack.
 */

const slackResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	warning: z.string().optional(),
	ts: z.string().optional(),
	channel: z.string().optional(),
});

export const slackChannels = ['signups', 'alerts'] as const;
export type SlackChannel = (typeof slackChannels)[number];

export type SlackSeverity = 'info' | 'warn' | 'error';

export interface SlackConfig {
	botToken: string;
	// Each channel's id, such as `C0123456789`, found at the bottom of its About pane in Slack.
	channels: Partial<Record<SlackChannel, string>>;
	env: EnvLabel;
	echoToStdout?: boolean;
	timeoutMs?: number;
}

export interface NotifyInput {
	channel: SlackChannel;
	title: string;
	body?: string;
	severity?: SlackSeverity;
	ctx?: Record<string, unknown>;
	// A message's `ts`, to post this one as a reply in its thread.
	threadTs?: string;
}

/** A posted message, as a thread's parent: pass `ts` back as `threadTs` to reply under it. */
export interface NotifyHandle {
	ts: string;
	channelId: string;
}

// Slack answers HTTP 200 with `{ok: false, error}` for what it refuses (channel_not_found,
// not_in_channel, invalid_auth…), told apart from the transport's failures.
export type SlackError = FetchError | {kind: 'slack_api_error'; error: string; warning?: string};

export interface Notifier {
	/** Posts the message; the handle to reply under it, or nothing where it wasn't posted. */
	notify(input: NotifyInput): Promise<NotifyHandle | undefined>;
}

export interface NotifierOptions {
	onError?: (error: SlackError, input: NotifyInput) => void;
}

interface SlackText {
	type: 'plain_text' | 'mrkdwn';
	text: string;
	emoji?: boolean;
}

type SlackBlock =
	| {type: 'header'; text: SlackText}
	| {type: 'section'; text?: SlackText; fields?: SlackText[]}
	| {type: 'context'; elements: SlackText[]};

export interface SlackPayload {
	channel: string;
	text: string;
	blocks: SlackBlock[];
	thread_ts?: string;
}

const SEVERITY_EMOJI: Record<SlackSeverity, string> = {
	info: ':information_source:',
	warn: ':warning:',
	error: ':rotating_light:',
};

const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

// Slack takes ten fields in a section.
const MAX_FIELDS = 10;

function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	return Result.wrap(() => JSON.stringify(value)).unwrapOr('[unserializable]');
}

export function formatSlackPayload(input: NotifyInput, channelId: string): SlackPayload {
	const severity = input.severity ?? 'info';
	const blocks: SlackBlock[] = [
		{type: 'header', text: {type: 'plain_text', text: input.title, emoji: true}},
	];

	if (input.body) {
		blocks.push({type: 'section', text: {type: 'mrkdwn', text: input.body}});
	}

	const entries = input.ctx ? Object.entries(input.ctx) : [];
	if (entries.length > 0) {
		blocks.push({
			type: 'section',
			fields: entries
				.slice(0, MAX_FIELDS)
				.map(([key, value]) => ({type: 'mrkdwn', text: `*${key}:* ${formatValue(value)}`})),
		});
	}
	if (entries.length > MAX_FIELDS) {
		blocks.push({
			type: 'context',
			elements: [{type: 'mrkdwn', text: `_…${entries.length - MAX_FIELDS} more field(s) omitted_`}],
		});
	}

	// `text` is what a notification shows, and what is shown where blocks can't be.
	const payload: SlackPayload = {
		channel: channelId,
		text: `${SEVERITY_EMOJI[severity]} ${input.title}`,
		blocks,
	};
	if (input.threadTs) {
		payload.thread_ts = input.threadTs;
	}
	return payload;
}

function echo(input: NotifyInput, reason: 'no_token' | 'no_channel' | 'sent'): void {
	const suffix = reason === 'sent' ? '' : `:off(${reason})`;
	console.log(
		`[notify:${input.channel}:${input.severity ?? 'info'}${suffix}]`,
		input.title,
		input.body ?? '',
		input.ctx ?? {},
	);
}

export function createNotifier(config: SlackConfig, options?: NotifierOptions): Notifier {
	const echoToStdout = config.echoToStdout ?? config.env === 'development';
	const timeoutMs = config.timeoutMs ?? 5_000;

	async function notify(input: NotifyInput): Promise<NotifyHandle | undefined> {
		if (!config.botToken) {
			if (echoToStdout) {
				echo(input, 'no_token');
			}
			return undefined;
		}

		const channelId = config.channels[input.channel];
		if (!channelId) {
			if (echoToStdout) {
				echo(input, 'no_channel');
			}
			return undefined;
		}

		if (echoToStdout) {
			echo(input, 'sent');
		}

		const result = await httpRequest(
			POST_MESSAGE_URL,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					Authorization: `Bearer ${config.botToken}`,
				},
				body: JSON.stringify(formatSlackPayload(input, channelId)),
			},
			{schema: slackResponseSchema, timeoutMs},
		);

		if (result.isErr()) {
			options?.onError?.(result.error, input);
			return undefined;
		}

		const answer = result.value;
		if (!answer.ok) {
			options?.onError?.(
				{kind: 'slack_api_error', error: answer.error ?? 'unknown', warning: answer.warning},
				input,
			);
			return undefined;
		}

		if (!answer.ts) {
			return undefined;
		}
		return {ts: answer.ts, channelId: answer.channel ?? channelId};
	}

	return {notify};
}

export function formatSlackError(error: SlackError): string {
	if (error.kind === 'slack_api_error') {
		const warning = error.warning ? ` (warning: ${error.warning})` : '';
		return `slack api error: ${error.error}${warning}`;
	}
	return formatFetchError(error);
}
