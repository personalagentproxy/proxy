import {createHash, randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';
import type {Result} from 'ts-results-es';

import {createDesktopAuthCode, createDesktopHandoff, getDesktopAuthCode, takeDesktopAuthCode, takeDesktopHandoff} from '@proxy/db/desktop-auth';
import {desktopCodeBodySchema, desktopHandoffBodySchema, desktopSessionBodySchema, type DesktopCode, type DesktopHandoff} from '@proxy/contracts/auth';
import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {authenticateApiRequest} from '../utils/auth';
import {env} from '../utils/env';
import {establishSession, hashToken, queryParam, redirectToLoginError, sanitizeCallbackUrl, timingSafeEqualString} from './session';

/**
 * Signing the desktop app in. The app can't sign in itself: Google turns embedded browsers away,
 * and a magic link opens in the browser anyway. So it makes a PKCE verifier, keeps it, and opens
 * the browser at `/desktop-auth?challenge=<its SHA-256>`, where the person signs in as they would
 * anywhere. That page mints a code bound to the challenge (`handleDesktopCodeRoute`) and hands it
 * to the app through its `personalagentproxy://` link; the app trades the code and the verifier
 * for a session cookie of its own (`handleDesktopSessionRoute`), and is signed in as the browser
 * is, with the same kind of session, for as long.
 *
 * The other way round, for what has to happen in the browser once the app is signed in, such as
 * connecting a service whose sign-in turns the app's window away as Google's does: the app asks
 * for a handoff (`handleDesktopHandoffRoute`), an address with a one-time code that signs the
 * browser in as the same person and goes on to where the app was headed
 * (`handleDesktopHandoffOpenRoute`), and opens it in the browser.
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

// Long enough for the browser to open, no longer.
const handoffMaxAgeMs = 2 * 60 * 1000;

/**
 * `POST /auth/desktop/handoff` `{next}` — the app's window, signed in: the address to open in the
 * browser, for `next`, a path in the app, as the sign-in's callback paths are.
 */
export function handleDesktopHandoffRoute(request: AuthenticatedRequest): Promise<Result<DesktopHandoff, ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requirePresent(env.APP_URL, ApiErr.internalError(new Error('APP_URL is not configured'))));
		const body = $(parseSchema(desktopHandoffBodySchema, request.body));
		const next = $(requirePresent(sanitizeCallbackUrl(body.next), ApiErr.validationError('next must be a path in the app')));
		const code = randomBytes(32).toString('hex');
		$(
			await createDesktopHandoff({
				codeHash: hashToken(code),
				userId: request.user.userId,
				next,
				expires: new Date(Date.now() + handoffMaxAgeMs),
			}),
		);
		return {url: `${appUrl}/auth/desktop/handoff?code=${code}`};
	});
}

/**
 * `GET /auth/desktop/handoff?code=` — the browser, opened by the app: signed in as the app's
 * person, unless it is already, and sent on to `next`. A code that is unknown, expired or taken
 * lands on the login page saying the link is no good, as a spent magic link does.
 */
export async function handleDesktopHandoffOpenRoute(req: Request, res: Response): Promise<void> {
	const appUrl = env.APP_URL;
	if (!appUrl) {
		res.status(500).json({error: 'app_url_not_configured'});
		return;
	}

	const code = queryParam(req, 'code');
	if (!code) {
		redirectToLoginError(res, appUrl, 'Verification');
		return;
	}

	const handoffResult = await takeDesktopHandoff(hashToken(code));
	if (handoffResult.isErr()) {
		log.error('Desktop handoff failed to take the code', serializeError(handoffResult.error));
		redirectToLoginError(res, appUrl, 'Callback');
		return;
	}

	const handoff = handoffResult.value;
	if (!handoff || handoff.expires.valueOf() < Date.now()) {
		redirectToLoginError(res, appUrl, 'Verification');
		return;
	}

	// The browser is usually signed in already, since the app was signed in through it: that
	// session stays. Signed in as someone else, or not at all, it is signed in as the app's person.
	const existing = await authenticateApiRequest(req.headers);
	const signedIn = existing.isOk() && existing.value.userId === handoff.userId;
	if (!signedIn) {
		const sessionResult = await establishSession(res, handoff.userId);
		if (sessionResult.isErr()) {
			log.error('Desktop handoff failed to create the session', serializeError(sessionResult.error));
			redirectToLoginError(res, appUrl, 'Callback');
			return;
		}
	}

	log.info('Desktop app handed over to the browser', {userId: handoff.userId, signedIn});
	res.redirect(`${appUrl}${handoff.next}`);
}
