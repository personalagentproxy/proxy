import {createHash, randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';
import type {Result} from 'ts-results-es';

import {createDesktopAuthCode, getDesktopAuthCode, takeDesktopAuthCode} from '@proxy/db/desktop-auth';
import {desktopCodeBodySchema, desktopSessionBodySchema, type DesktopCode} from '@proxy/contracts/auth';
import {type ApiError, Do, parseSchema} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {establishSession, hashToken, timingSafeEqualString} from './session';

/**
 * Signing the desktop app in. The app can't sign in itself: Google turns embedded browsers away,
 * and a magic link opens in the browser anyway. So it makes a PKCE verifier, keeps it, and opens
 * the browser at `/desktop-auth?challenge=<its SHA-256>`, where the person signs in as they would
 * anywhere. That page mints a code bound to the challenge (`handleDesktopCodeRoute`) and hands it
 * to the app through its `personalagentproxy://` link; the app trades the code and the verifier
 * for a session cookie of its own (`handleDesktopSessionRoute`), and is signed in as the browser
 * is, with the same kind of session, for as long.
 *
 * Nothing signs the browser in the other way round. What has to happen in the browser once the
 * app is signed in, such as connecting a service whose sign-in turns the app's window away as
 * Google's does, the web app opens there through the login page, which sends a signed-in browser
 * straight on and lets any other sign in as itself first. A code the app could mint for the browser
 * would be a link that signs whoever opens it in as the app's person.
 */

// Long enough to click through the browser's "open the app?" prompt, no longer.
const codeMaxAgeMs = 5 * 60 * 1000;

/**
 * `POST /auth/desktop/code` `{challenge}` — the browser's, signed in: a one-time code for the
 * person, bound to the app's challenge. The code travels once, through the app's link.
 */
export function handleDesktopCodeRoute(request: AuthenticatedRequest): Promise<Result<DesktopCode, ApiError>> {
	return Do(async ($) => {
		const {challenge} = $(parseSchema(desktopCodeBodySchema, request.body));
		const code = randomBytes(32).toString('hex');
		$(
			await createDesktopAuthCode({
				codeHash: hashToken(code),
				challenge,
				userId: request.user.userId,
				expires: new Date(Date.now() + codeMaxAgeMs),
			}),
		);
		return {code};
	});
}

function verifierMatches(verifier: string, challenge: string): boolean {
	const computed = createHash('sha256').update(verifier).digest('base64url');
	return timingSafeEqualString(computed, challenge);
}

/**
 * `POST /auth/desktop/session` `{code, verifier}` — the app's, from its own process, with no
 * session and no browser Origin: the code and the verifier are what lets it in. A code that is
 * unknown, expired or taken, or a verifier that isn't the challenge's, is one answer, `invalid_code`,
 * so nothing is learnt by trying. The verifier is checked before the code is taken, so a wrong one
 * leaves the code to the app that holds the right one.
 */
export async function handleDesktopSessionRoute(req: Request, res: Response): Promise<void> {
	const parsed = desktopSessionBodySchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({error: 'invalid_body'});
		return;
	}

	const {code, verifier} = parsed.data;
	const codeHash = hashToken(code);
	const codeResult = await getDesktopAuthCode(codeHash);
	if (codeResult.isErr()) {
		log.error('Desktop sign-in failed to read the code', serializeError(codeResult.error));
		res.status(500).json({error: 'internal_error'});
		return;
	}

	const authCode = codeResult.value;
	if (!authCode || authCode.expires.valueOf() < Date.now()) {
		res.status(400).json({error: 'invalid_code'});
		return;
	}

	if (!verifierMatches(verifier, authCode.challenge)) {
		log.warn('Desktop sign-in with a verifier that is not the code’s', {userId: authCode.userId});
		res.status(400).json({error: 'invalid_code'});
		return;
	}

	const takenResult = await takeDesktopAuthCode(codeHash);
	if (takenResult.isErr()) {
		log.error('Desktop sign-in failed to take the code', serializeError(takenResult.error));
		res.status(500).json({error: 'internal_error'});
		return;
	}

	if (!takenResult.value) {
		res.status(400).json({error: 'invalid_code'});
		return;
	}

	const sessionResult = await establishSession(res, authCode.userId);
	if (sessionResult.isErr()) {
		log.error('Desktop sign-in failed to create the session', serializeError(sessionResult.error));
		res.status(500).json({error: 'internal_error'});
		return;
	}

	log.info('Desktop app signed in', {userId: authCode.userId});
	res.json({ok: true});
}
