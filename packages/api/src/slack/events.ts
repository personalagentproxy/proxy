import {createHmac} from 'node:crypto';

import type {Request, Response} from 'express';
import {Result} from 'ts-results-es';
import {z} from 'zod';

import {hasExperiment, organizationExperiments} from '@proxy/utils';
import {getSlackAppForEvents, markSlackAppRemoved, type SlackAppForEvents} from '@proxy/db/slack';

import {timingSafeEqualString} from '../auth/session';
import {readBody} from '../cli/github/peek';
import {log, serializeError} from '../observability/log';
import {readSlackMessage, slackMessageSchema} from './message-rules';
import {postSlackLines, type SlackLine, takeUpSlackMessageFrom} from './messages';
import {readAppSecrets} from './secrets';

/**
 * `POST /slack/events/:id`: what Slack sends a persona's app through the Events API, `:id` our id
 * for the app (SlackApp). Mounted before the JSON parser, so the body is read as it came and the
 * signature checked against it with the app's signing secret, and the timestamp against the clock,
 * before anything in it is believed
 * (https://docs.slack.dev/authentication/verifying-requests-from-slack). Slack checks the address
 * with `url_verification`, answered with its challenge; `app_uninstalled` and `tokens_revoked` mark
 * the app removed in Slack; a person's message in the app's DM is taken up by `takeUpEvent`
 * (messages.ts), anything else left. Every request that passes the check is answered 200 once the
 * database's work is done, whatever came of it, so nothing Slack sends is retried for an error of
 * ours, and the app's lines are said in Slack after; one that doesn't is refused, and one for an
 * app we don't have is not found. Nothing of Slack is answered for an organization without the
 * `slack` experiment.
 */

// Slack's events are small; anything near this isn't one.
const BODY_LIMIT = 1024 * 1024;
// How far a request's timestamp may be from our clock, as Slack's guide says.
const MAX_SKEW_SECONDS = 5 * 60;
// How long after the row is made Slack may check the address before we have the secret.
const CREATING_MS = 5 * 60 * 1000;

const urlVerificationSchema = z.object({type: z.literal('url_verification'), challenge: z.string()});

const eventCallbackSchema = z.object({
	type: z.literal('event_callback'),
	api_app_id: z.string().optional(),
	team_id: z.string().optional(),
	event_id: z.string().optional(),
	event: z.looseObject({
		type: z.string(),
		// `tokens_revoked`: the user ids whose tokens went, by kind; a bot's under `bot`.
		tokens: z.object({oauth: z.array(z.string()).optional(), bot: z.array(z.string()).optional()}).optional(),
	}),
});

/** What Slack sends with an event: its envelope, and the event itself. */
type SlackEventEnvelope = z.infer<typeof eventCallbackSchema>;

// Anything Slack sends has a type; what else it has, each kind's schema reads.
const envelopeSchema = z.looseObject({type: z.string()});

/** What checking a request's signature came to: from Slack, too old or new, or not signed by the app's secret. */
export type SignatureCheck = 'ok' | 'stale' | 'bad';

/**
 * Whether the request was signed with the app's signing secret: `v0=` and the hex HMAC SHA-256 of
 * `v0:<timestamp>:<body>`, its timestamp within five minutes of `nowMs`, compared in constant time.
 */
export function checkSlackSignature(signingSecret: string, headers: {timestamp: string | undefined; signature: string | undefined}, body: Buffer, nowMs: number): SignatureCheck {
	const timestamp = Number(headers.timestamp);
	if (!headers.timestamp || !Number.isInteger(timestamp) || !headers.signature) {
		return 'bad';
	}
	if (Math.abs(nowMs / 1000 - timestamp) > MAX_SKEW_SECONDS) {
		return 'stale';
	}
	const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${headers.timestamp}:`).update(body).digest('hex')}`;
	return timingSafeEqualString(expected, headers.signature) ? 'ok' : 'bad';
}

function header(request: Request, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function parseEnvelope(body: Buffer): z.infer<typeof envelopeSchema> | null {
	const json = Result.wrap((): unknown => JSON.parse(body.toString('utf8')));
	if (json.isErr()) {
		return null;
	}
	const parsed = envelopeSchema.safeParse(json.value);
	return parsed.success ? parsed.data : null;
}

/**
 * Every event of the app's other than its removal: a person's message in its DM, taken up as
 * messages.ts does, while the app is in Slack; anything else left. The lines it comes to, to say
 * once Slack has its answer.
 */
async function takeUpEvent(app: SlackAppForEvents, envelope: SlackEventEnvelope): Promise<SlackLine[]> {
	if (app.removedAt !== null || app.botToken === null) {
		return [];
	}
	const message = slackMessageSchema.safeParse(envelope.event);
	if (!message.success || message.data.channel === undefined) {
		return [];
	}
	const said = readSlackMessage(message.data, {channel: message.data.channel, channelType: message.data.channel_type, botUserId: app.botUserId});
	if (said === null) {
		return [];
	}
	return (await takeUpSlackMessageFrom(app, said)).lines;
}

// What an event that passed the check comes to: the app marked removed where Slack took it out of
// the workspace, or its bot's token went; anything else taken up. The lines to say after.
async function handleEvent(app: SlackAppForEvents, envelope: SlackEventEnvelope): Promise<SlackLine[]> {
	// An event for another app than this one's address is for isn't this app's to act on.
	if (envelope.api_app_id !== undefined && envelope.api_app_id !== app.slackAppId) {
		log.warn('A Slack event came for another app than its address', {appId: app.id, eventId: envelope.event_id});
		return [];
	}
	const {event} = envelope;
	const removed = event.type === 'app_uninstalled' || (event.type === 'tokens_revoked' && (event.tokens?.bot ?? []).length > 0);
	if (!removed) {
		return takeUpEvent(app, envelope);
	}
	const marked = await markSlackAppRemoved(app.id);
	if (marked.isErr()) {
		log.error('A Slack app removed in Slack could not be marked so', {appId: app.id, ...serializeError(marked.error)});
	}
	return [];
}

/** `POST /slack/events/:id`. */
export async function handleSlackEventsRoute(request: Request, res: Response): Promise<void> {
	const body = await readBody(request, BODY_LIMIT);
	if (body === null) {
		res.status(413).json({error: 'too_large'});
		return;
	}
	const found = await getSlackAppForEvents(request.params.id ?? '');
	if (found.isErr()) {
		res.status(500).json({error: 'internal_error'});
		return;
	}
	const app = found.value;
	if (!app || !hasExperiment({experiments: organizationExperiments(app.org)}, 'slack')) {
		res.status(404).json({error: 'not_found'});
		return;
	}
	if (app.secrets === null) {
		// Slack checks the address as it makes the app, before it has told us the app's signing
		// secret, so there is nothing to check the signature with yet. Answering the challenge then
		// is safe: it only sends back what the request itself holds, tells nothing of ours and
		// changes nothing, and only for an app whose row was made moments ago and whose secret
		// hasn't come; every other request without a secret is refused.
		const verification = Date.now() - app.createdAt.getTime() < CREATING_MS ? urlVerificationSchema.safeParse(parseEnvelope(body)) : null;
		if (verification?.success) {
			res.json({challenge: verification.data.challenge});
			return;
		}
		res.status(401).json({error: 'unsigned'});
		return;
	}
	const secrets = readAppSecrets(app.secrets);
	if (secrets.isErr()) {
		log.error('A Slack app’s secrets could not be read', {appId: app.id});
		res.status(500).json({error: 'internal_error'});
		return;
	}
	const checked = checkSlackSignature(secrets.value.signingSecret, {timestamp: header(request, 'x-slack-request-timestamp'), signature: header(request, 'x-slack-signature')}, body, Date.now());
	if (checked !== 'ok') {
		res.status(401).json({error: checked === 'stale' ? 'stale_request' : 'bad_signature'});
		return;
	}
	const envelope = parseEnvelope(body);
	if (envelope === null) {
		res.status(400).json({error: 'parse_error'});
		return;
	}
	const verification = urlVerificationSchema.safeParse(envelope);
	if (verification.success) {
		res.json({challenge: verification.data.challenge});
		return;
	}
	const callback = eventCallbackSchema.safeParse(envelope);
	const lines = callback.success ? await handleEvent(app, callback.data) : [];
	res.status(200).end();
	// Said once Slack has its answer, which it wants within three seconds.
	await postSlackLines(app, lines);
}
