import {createHmac, hkdfSync, timingSafeEqual} from 'node:crypto';

import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

/**
 * The link a persona's app gives a Slack user linked to nobody in the organization, to confirm who
 * they are: `<APP_URL>/confirm-slack/<token>`, a page of the web app. The token carries everything
 * confirming needs, so nothing is kept until they confirm: the app (our id for it), its workspace,
 * the Slack user, the DM's channel and the message that prompted it, which is then read back from
 * Slack and taken up. It is `<payload>.<signature>`, the payload those as JSON and the signature an
 * HMAC-SHA256 of the payload, both base64url, with a key derived from AUTH_SECRET for this alone,
 * as the CLI's tokens are (cli/token.ts); so it can't be made up or altered. It runs out after a day.
 */

const KEY_INFO = 'personal-agent-proxy slack confirm v1';

/** How long a link works. */
export const CONFIRM_LINK_MS = 24 * 60 * 60 * 1000;

/** What a link is for: the app, its workspace, the Slack user, the DM's channel and the message's `ts`, and when it runs out, in seconds since the epoch. */
export type ConfirmClaims = {appId: string; teamId: string; slackUserId: string; channel: string; ts: string; expiresAt: number};

const payloadSchema = z.object({app: z.string().min(1), team: z.string().min(1), user: z.string().min(1), channel: z.string().min(1), ts: z.string().min(1), exp: z.number().int()});

/** Why a link doesn't work: not one of ours, or altered; or one of ours that has run out. */
export type ConfirmLinkError = 'invalid' | 'expired';

function sign(payload: string, secret: string): Buffer {
	const key = Buffer.from(hkdfSync('sha256', secret, '', KEY_INFO, 32));
	return createHmac('sha256', key).update(payload).digest();
}

/** The token for the claims, signed with a key made from `secret`. */
export function signConfirmToken(claims: ConfirmClaims, secret: string): string {
	const payload = Buffer.from(JSON.stringify({app: claims.appId, team: claims.teamId, user: claims.slackUserId, channel: claims.channel, ts: claims.ts, exp: claims.expiresAt})).toString('base64url');
	return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

/** The claims of a token `secret` signed, where it has not run out by `now`. */
export function readConfirmToken(token: string, secret: string, now = new Date()): Result<ConfirmClaims, ConfirmLinkError> {
	const dot = token.indexOf('.');
	if (dot === -1) {
		return Err('invalid');
	}
	const payload = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = sign(payload, secret);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return Err('invalid');
	}
	const json = Result.wrap((): unknown => JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
	const parsed = payloadSchema.safeParse(json.unwrapOr(null));
	if (!parsed.success) {
		return Err('invalid');
	}
	const {app, team, user, channel, ts, exp} = parsed.data;
	if (exp * 1000 <= now.getTime()) {
		return Err('expired');
	}
	return Ok({appId: app, teamId: team, slackUserId: user, channel, ts, expiresAt: exp});
}

/** The page a token opens. */
export function confirmUrl(appUrl: string, token: string): string {
	return `${appUrl}/confirm-slack/${token}`;
}
