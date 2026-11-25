import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {type FetchError, httpRequest, readJsonValidated} from '@proxy/utils';

import {type SlackMessage, slackMessageSchema} from './message-rules';

/**
 * Slack's Web API, as much of it as Personal Agent Proxy calls: each method a form-encoded POST to
 * `https://slack.com/api/<method>`, answering JSON with `ok`. A refusal comes as `ok: false` with
 * Slack's code for it (`SlackError` `refused`), and a manifest Slack won't take with what is wrong
 * where in it; a rate limit as HTTP 429 with `Retry-After`; anything else that isn't an answer, a
 * network failure, a timeout or a body that isn't Slack's, as `unreachable`.
 */

const SLACK_API = 'https://slack.com/api';

// Slack asks for an answer to its own requests within three seconds; ours to it get a little more.
const TIMEOUT_MS = 10_000;

/** What is wrong in a manifest Slack won't take, and where in it, as `/display_information/name`. */
export type ManifestProblem = {message: string; pointer: string};

export type SlackError =
	| {kind: 'refused'; method: string; error: string; problems: ManifestProblem[]}
	| {kind: 'rate_limited'; method: string; retryAfterSeconds: number | null}
	| {kind: 'unreachable'; method: string; cause: FetchError};

const refusalSchema = z.object({
	ok: z.literal(false),
	error: z.string(),
	errors: z.array(z.object({message: z.string(), pointer: z.string().default('')})).optional(),
});

type Auth = {token: string} | {clientId: string; clientSecret: string} | null;

function authorization(auth: Auth): Record<string, string> {
	if (auth === null) {
		return {};
	}
	if ('token' in auth) {
		return {authorization: `Bearer ${auth.token}`};
	}
	return {authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`};
}

// Calls a method with `params`, form-encoded, as `auth` says: a token as a bearer, a client's id
// and secret as Basic, as `oauth.v2.access` prefers them, or nothing. Its answer read with
// `schema` where it is `ok`.
async function call<S extends z.ZodType>(method: string, params: Record<string, string>, auth: Auth, schema: S): Promise<Result<z.infer<S>, SlackError>> {
	const url = `${SLACK_API}/${method}`;
	const sent = await httpRequest(
		url,
		{method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', ...authorization(auth)}, body: new URLSearchParams(params).toString()},
		{parse: 'response', timeoutMs: TIMEOUT_MS, allowStatus: (status) => (status >= 200 && status < 300) || status === 429},
	);
	if (sent.isErr()) {
		return Err({kind: 'unreachable', method, cause: sent.error});
	}
	const response = sent.value;
	if (response.status === 429) {
		await response.body?.cancel();
		const after = Number(response.headers.get('retry-after'));
		return Err({kind: 'rate_limited', method, retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : null});
	}
	const answer = await readJsonValidated(response, z.union([refusalSchema, schema]), url);
	if (answer.isErr()) {
		return Err({kind: 'unreachable', method, cause: answer.error});
	}
	const refused = refusalSchema.safeParse(answer.value);
	if (!refused.success) {
		const ok = schema.safeParse(answer.value);
		return ok.success ? Ok(ok.data) : Err({kind: 'unreachable', method, cause: {kind: 'schema', url, issues: ok.error.issues}});
	}
	// Slack has said `ratelimited` in the body too, where the method's own limit is meant.
	if (refused.data.error === 'ratelimited') {
		return Err({kind: 'rate_limited', method, retryAfterSeconds: null});
	}
	return Err({kind: 'refused', method, error: refused.data.error, problems: refused.data.errors ?? []});
}

/** A configuration token rotated: the new token and refresh token, whose workspace and Slack user, and when it runs out. */
export type RotatedToken = {token: string; refreshToken: string; teamId: string; userId: string; expiresAt: Date};

const rotatedSchema = z.object({ok: z.literal(true), token: z.string().min(1), refresh_token: z.string().min(1), team_id: z.string(), user_id: z.string(), exp: z.number()});

/** `tooling.tokens.rotate`: a new app configuration token for the refresh token, which is spent. */
export async function rotateConfigurationToken(refreshToken: string): Promise<Result<RotatedToken, SlackError>> {
	// Takes no token of its own: the refresh token is the argument.
	return (await call('tooling.tokens.rotate', {refresh_token: refreshToken}, null, rotatedSchema)).map((answer) => ({
		token: answer.token,
		refreshToken: answer.refresh_token,
		teamId: answer.team_id,
		userId: answer.user_id,
		expiresAt: new Date(answer.exp * 1000),
	}));
}

/** Who a token is: its workspace's id and name, and its user's id and handle. */
export type TokenIdentity = {teamId: string; team: string; userId: string; user: string};

const identitySchema = z.object({ok: z.literal(true), team_id: z.string(), team: z.string(), user_id: z.string(), user: z.string()});

/** `auth.test`: whether the token works, and whose it is. */
export async function testToken(token: string): Promise<Result<TokenIdentity, SlackError>> {
	return (await call('auth.test', {}, {token}, identitySchema)).map((answer) => ({teamId: answer.team_id, team: answer.team, userId: answer.user_id, user: answer.user}));
}

/** A new app as Slack made it: its id and client, and the secrets Slack gave it. */
export type CreatedApp = {appId: string; clientId: string; clientSecret: string; signingSecret: string};

const createdSchema = z.object({
	ok: z.literal(true),
	app_id: z.string().min(1),
	credentials: z.object({client_id: z.string().min(1), client_secret: z.string().min(1), signing_secret: z.string().min(1)}),
});

/** `apps.manifest.create`, with a configuration token: a new app from the manifest. */
export async function createApp(token: string, manifest: object): Promise<Result<CreatedApp, SlackError>> {
	return (await call('apps.manifest.create', {manifest: JSON.stringify(manifest)}, {token}, createdSchema)).map((answer) => ({
		appId: answer.app_id,
		clientId: answer.credentials.client_id,
		clientSecret: answer.credentials.client_secret,
		signingSecret: answer.credentials.signing_secret,
	}));
}

const updatedSchema = z.object({ok: z.literal(true), permissions_updated: z.boolean().optional()});

/** `apps.manifest.update`: the app's whole configuration replaced with the manifest. */
export async function updateApp(token: string, appId: string, manifest: object): Promise<Result<void, SlackError>> {
	return (await call('apps.manifest.update', {app_id: appId, manifest: JSON.stringify(manifest)}, {token}, updatedSchema)).map(() => undefined);
}

const doneSchema = z.object({ok: z.literal(true)});

/** `apps.manifest.delete`: the app deleted in Slack, uninstalled wherever it was. */
export async function deleteApp(token: string, appId: string): Promise<Result<void, SlackError>> {
	return (await call('apps.manifest.delete', {app_id: appId}, {token}, doneSchema)).map(() => undefined);
}

/**
 * An install's answer: the bot's token and user id, the scopes granted, the app it is for, and
 * where it was installed: a workspace, or a whole Enterprise organization (`enterprise`), where
 * Slack has no workspace for it.
 */
export type Installed = {botToken: string; botUserId: string; appId: string; scopes: string[]; team: {id: string; name: string} | null; enterprise: boolean};

const installedSchema = z.object({
	ok: z.literal(true),
	access_token: z.string().min(1),
	token_type: z.string().optional(),
	scope: z.string().default(''),
	bot_user_id: z.string().min(1),
	app_id: z.string(),
	team: z
		.object({id: z.string(), name: z.string().default('')})
		.nullable()
		.optional(),
	is_enterprise_install: z.boolean().optional(),
});

/** `oauth.v2.access`: the code Slack's install came back with traded for the bot's token, with the app's client as Basic. */
export async function exchangeInstallCode(client: {clientId: string; clientSecret: string}, args: {code: string; redirectUri: string}): Promise<Result<Installed, SlackError>> {
	return (await call('oauth.v2.access', {code: args.code, redirect_uri: args.redirectUri}, client, installedSchema)).map((answer) => ({
		botToken: answer.access_token,
		botUserId: answer.bot_user_id,
		appId: answer.app_id,
		scopes: answer.scope.split(',').filter((scope) => scope !== ''),
		team: answer.team ?? null,
		enterprise: answer.is_enterprise_install === true,
	}));
}

/** Where an app's messages are in Slack, which opens them in its workspace. */
export function slackAppUrl(slackAppId: string, teamId: string): string {
	const url = new URL('https://slack.com/app_redirect');
	url.searchParams.set('app', slackAppId);
	url.searchParams.set('team', teamId);
	return url.toString();
}

const postedSchema = z.object({ok: z.literal(true), ts: z.string()});

/**
 * What a message carries for the app alone, as message metadata
 * (https://docs.slack.dev/messaging/message-metadata): the root message of a thread opened in Slack
 * names the thread's place, so it can be found in the DM again (findRootMessage).
 */
export const ROOT_EVENT = 'thread_opened';

/**
 * A message to post: in Slack's own text format (`text`), or in standard Markdown (`markdown`),
 * which Slack takes in `markdown_text` alone, at most 12,000 characters; in the Slack thread under
 * `threadTs`, or at the top of the DM where it is null, as a thread's root message is, which names
 * its place (`place`).
 */
export type SlackPost = {channel: string; threadTs: string | null; place?: string} & ({text: string} | {markdown: string});

// What chat.postMessage answers where it won't take a message's metadata, which the message is
// posted again without. Its reference page says metadata "can only be posted or updated using an
// app-level token" (`metadata_must_be_sent_from_app`), while the message metadata guide posts it
// with a bot token, which is what the app has; which holds isn't confirmed.
const METADATA_REFUSED = ['metadata_must_be_sent_from_app', 'invalid_metadata_format', 'invalid_metadata_schema', 'metadata_too_large'];

/**
 * `chat.postMessage` with the app's bot token: a message in the DM `channel`, in the Slack thread
 * under `threadTs` or at the top, its links not unfurled, naming its place in its metadata where it
 * is given one (https://docs.slack.dev/reference/methods/chat.postMessage). Where Slack won't take
 * the metadata, the message is posted without it. Its `ts`.
 */
export async function postMessage(botToken: string, post: SlackPost): Promise<Result<{ts: string}, SlackError>> {
	const {place, ...rest} = post;
	const said: Record<string, string> = 'markdown' in post ? {markdown_text: post.markdown} : {text: post.text};
	const thread: Record<string, string> = post.threadTs === null ? {} : {thread_ts: post.threadTs};
	const metadata: Record<string, string> = place === undefined ? {} : {metadata: JSON.stringify({event_type: ROOT_EVENT, event_payload: {place}})};
	const posted = await call('chat.postMessage', {channel: post.channel, ...thread, ...said, ...metadata, unfurl_links: 'false', unfurl_media: 'false'}, {token: botToken}, postedSchema);
	if (posted.isErr() && place !== undefined && posted.error.kind === 'refused' && METADATA_REFUSED.includes(posted.error.error)) {
		return postMessage(botToken, rest);
	}
	return posted.map((answer) => ({ts: answer.ts}));
}

const openedSchema = z.object({ok: z.literal(true), channel: z.object({id: z.string().min(1)})});

/**
 * `conversations.open` with the app's bot token, which needs `im:write`: the app's DM with the
 * Slack user, its channel, made where there is none
 * (https://docs.slack.dev/reference/methods/conversations.open).
 */
export async function openDirectMessage(botToken: string, slackUserId: string): Promise<Result<string, SlackError>> {
	return (await call('conversations.open', {users: slackUserId}, {token: botToken}, openedSchema)).map((answer) => answer.channel.id);
}

// A message as `conversations.history` reads it with its metadata: its `ts`, where it is in a
// thread its root's, and the place a root message of ours names; any other metadata is none.
const historySchema = z.object({
	ok: z.literal(true),
	messages: z
		.array(
			z.looseObject({
				ts: z.string(),
				thread_ts: z.string().optional(),
				metadata: z
					.object({event_type: z.literal(ROOT_EVENT), event_payload: z.object({place: z.string()})})
					.optional()
					.catch(undefined),
			}),
		)
		.default([]),
});

// How far back from when a root message was first tried it is looked for, as Slack's clock and
// ours may differ; and how many messages since are read, the DM being one member's with the app.
const ROOT_LOOKBACK_SECONDS = 300;
const ROOT_LOOK_LIMIT = 200;

/**
 * `conversations.history` with the app's bot token, which `im:history` allows, with every message's
 * metadata (`include_all_metadata`, https://docs.slack.dev/reference/methods/conversations.history):
 * the `ts` of the root message at the top of the DM `channel` naming the place `place`, posted
 * since `since`, give or take Slack's clock; `Ok(null)` for none. For a root whose post's answer
 * never came back, so it is posted once.
 */
export async function findRootMessage(botToken: string, at: {channel: string; place: string; since: Date}): Promise<Result<string | null, SlackError>> {
	const oldest = (Math.floor(at.since.getTime() / 1000) - ROOT_LOOKBACK_SECONDS).toString();
	const read = await call('conversations.history', {channel: at.channel, oldest, limit: String(ROOT_LOOK_LIMIT), include_all_metadata: 'true'}, {token: botToken}, historySchema);
	return read.map(({messages}) => messages.find((message) => message.metadata?.event_payload.place === at.place && (message.thread_ts === undefined || message.thread_ts === message.ts))?.ts ?? null);
}

/** A Slack agent session's status: at work, waiting for the member, or ready for their next message. */
export type SessionStatus = 'processing' | 'suspended' | 'active';

/** Slack's limit on a session's title. */
const SESSION_TITLE_MAX = 200;

// The title as Slack takes it: trimmed, and cut to its limit; empty for none.
function sessionTitle(title: string | null): string {
	return title === null ? '' : Array.from(title.trim()).slice(0, SESSION_TITLE_MAX).join('');
}

/**
 * `agents.sessions.setStatus` with the app's bot token: the status of the agent session on the
 * Slack thread under `threadTs` in the DM `channel`, made where there is none, with `title`, which
 * Slack takes only as it makes one (https://docs.slack.dev/reference/methods/agents.sessions.setStatus).
 * A warning Slack answers with, as `missing_agent_session_stopped_event_subscription` for an app
 * with no stop button, is an answer like any other.
 */
export async function setSessionStatus(botToken: string, session: {channel: string; threadTs: string; status: SessionStatus; title: string | null}): Promise<Result<void, SlackError>> {
	const title = sessionTitle(session.title);
	const params = {channel_id: session.channel, thread_ts: session.threadTs, status: session.status, ...(title === '' ? {} : {title})};
	return (await call('agents.sessions.setStatus', params, {token: botToken}, doneSchema)).map(() => undefined);
}

/**
 * `agents.sessions.rename` with the app's bot token: the agent session on the Slack thread under
 * `threadTs` in the DM `channel` given `title`, which Slack takes at 1 to 200 characters
 * (https://docs.slack.dev/reference/methods/agents.sessions.rename).
 */
export async function renameSession(botToken: string, session: {channel: string; threadTs: string; title: string}): Promise<Result<void, SlackError>> {
	return (await call('agents.sessions.rename', {channel_id: session.channel, thread_ts: session.threadTs, title: sessionTitle(session.title)}, {token: botToken}, doneSchema)).map(() => undefined);
}

const repliesSchema = z.object({ok: z.literal(true), messages: z.array(slackMessageSchema).default([])});

// What Slack says where the message, or the thread it was in, is there no more.
const GONE = ['thread_not_found', 'message_not_found'];

/**
 * `conversations.replies` with the app's bot token: the message `ts` in the DM `channel`, read
 * back, whether at the top of the DM or in a thread, which this method reads either way and
 * `conversations.history` doesn't; `Ok(null)` where Slack has it no more.
 */
export async function readMessage(botToken: string, at: {channel: string; ts: string}): Promise<Result<SlackMessage | null, SlackError>> {
	const read = await call('conversations.replies', {channel: at.channel, ts: at.ts, oldest: at.ts, latest: at.ts, inclusive: 'true'}, {token: botToken}, repliesSchema);
	if (read.isErr()) {
		return read.error.kind === 'refused' && GONE.includes(read.error.error) ? Ok(null) : Err(read.error);
	}
	return Ok(read.value.messages.find((message) => message.ts === at.ts) ?? null);
}
