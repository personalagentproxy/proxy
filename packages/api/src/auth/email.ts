import {createHash, randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';

import {createVerificationToken, useVerificationToken} from '@proxy/db/auth';
import {createUserFromEmail, getUserByEmail, setUserEmailVerified} from '@proxy/db/user';

import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {sendMagicLink} from './mail';
import {canSignUp, establishSessionAndRedirect, queryParam, redirectToLoginError, sanitizeCallbackUrl} from './session';

/**
 * Magic-link sign-in. The emailed link carries a random token; the database stores only its hash
 * with AUTH_SECRET, valid for 24 hours and deleted as it is read, so a link works once. The first
 * verify creates the user; every later one signs them in.
 *
 * `POST /auth/email` is a fetch from the web app (no auth middleware);
 * `GET /auth/email/verify` is a top-level navigation (302 redirects).
 */

const verificationTokenMaxAgeSeconds = 24 * 60 * 60;

type EmailAuthConfig = {
	secret: string;
	/** The app origin (where the user lands after sign-in). */
	appUrl: string;
	/** The verify endpoint, on the app's origin — the URL the emailed link points at. */
	verifyUrl: string;
};

function getEmailAuthConfig(): EmailAuthConfig | null {
	if (!env.AUTH_SECRET || !env.APP_URL) {
		return null;
	}

	return {
		secret: env.AUTH_SECRET,
		appUrl: env.APP_URL,
		verifyUrl: `${env.APP_URL}/auth/email/verify`,
	};
}

function hashVerificationToken(token: string, secret: string): string {
	return createHash('sha256').update(`${token}${secret}`).digest('hex');
}

/**
 * Trims, rejects multiple `@`s and quoted locals, lowercases, drops everything after the first
 * comma in the domain, and requires a dot in the domain. Null for anything else.
 */
function normalizeEmail(raw: string): string | null {
	const trimmed = raw.trim();
	const atCount = (trimmed.match(/@/g) ?? []).length;
	if (atCount !== 1) {
		return null;
	}

	if (trimmed.includes('"')) {
		return null;
	}

	const [local, domainRaw] = trimmed.toLowerCase().split('@');
	if (!local || !domainRaw) {
		return null;
	}

	const domain = domainRaw.split(',')[0];
	if (!domain || !domain.includes('.')) {
		return null;
	}

	return `${local}@${domain}`;
}

/**
 * `POST /auth/email` `{email, callbackUrl?}` — issues a verification token and emails the magic
 * link (or logs it in dev). Errors carry the codes the login form maps to copy.
 */
export async function handleEmailSignInRoute(req: Request, res: Response): Promise<void> {
	const config = getEmailAuthConfig();
	if (!config) {
		log.error('Email sign-in route called without complete email auth configuration');
		res.status(500).json({error: 'EmailSignin'});
		return;
	}

	const body = req.body as {email?: unknown; callbackUrl?: unknown} | undefined;
	const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '');
	if (!email) {
		res.status(400).json({error: 'EmailSignin'});
		return;
	}

	// Only someone who could finish signing in gets a link, so Proxy does not email anyone else.
	if (!canSignUp(email)) {
		const existingResult = await getUserByEmail(email);
		if (existingResult.isErr()) {
			log.error('Email sign-in user lookup failed', serializeError(existingResult.error));
			res.status(500).json({error: 'EmailSignin'});
			return;
		}

		if (!existingResult.value) {
			res.status(403).json({error: 'SignupNotAllowed'});
			return;
		}
	}

	const callbackUrl = sanitizeCallbackUrl(typeof body?.callbackUrl === 'string' ? body.callbackUrl : undefined) ?? '/';
	const token = randomBytes(32).toString('hex');
	const expires = new Date(Date.now() + verificationTokenMaxAgeSeconds * 1000);
	const tokenResult = await createVerificationToken({
		identifier: email,
		token: hashVerificationToken(token, config.secret),
		expires,
	});
	if (tokenResult.isErr()) {
		log.error('Email sign-in failed to store verification token', serializeError(tokenResult.error));
		res.status(500).json({error: 'EmailSignin'});
		return;
	}

	const url = `${config.verifyUrl}?${new URLSearchParams({token, email, callbackUrl}).toString()}`;

	// Without a way to send email, whoever runs Proxy can read the link from its log.
	if (env.NODE_ENV === 'development' || !env.RESEND_KEY) {
		log.info(`[Magic Link] ${email}: ${url}`);
		res.json({ok: true, logged: true});
		return;
	}

	const sendResult = await sendMagicLink({email, url});
	if (sendResult.isErr()) {
		log.error('[Magic Link] Failed to send email', serializeError(sendResult.error));
		res.status(500).json({error: 'EmailSignin'});
		return;
	}

	res.json({ok: true});
}

/**
 * `GET /auth/email/verify?token&email&callbackUrl` — consumes the token, then:
 *
 * 1. Missing/unknown/expired token → `Verification` error.
 * 2. Existing user → refresh `emailVerified`, sign in.
 * 3. No user → create one with `emailVerified` set, sign up.
 */
export async function handleEmailVerifyRoute(req: Request, res: Response): Promise<void> {
	const config = getEmailAuthConfig();
	if (!config) {
		log.error('Email verify route called without complete email auth configuration');
		if (!env.APP_URL) {
			res.status(500).json({error: 'email_auth_not_configured'});
			return;
		}

		redirectToLoginError(res, env.APP_URL, 'Verification');
		return;
	}

	const token = queryParam(req, 'token');
	const rawEmail = queryParam(req, 'email');
	const callbackUrl = sanitizeCallbackUrl(queryParam(req, 'callbackUrl') ?? undefined) ?? '/';
	if (!token || !rawEmail) {
		redirectToLoginError(res, config.appUrl, 'Verification');
		return;
	}

	// Real links already carry a normalized address; this rescues ones whose casing or whitespace
	// changed in transit, which would otherwise miss a valid token.
	const email = normalizeEmail(rawEmail);
	if (!email) {
		redirectToLoginError(res, config.appUrl, 'Verification');
		return;
	}

	// Keyed on (identifier, token), so a token only verifies the address it was sent to.
	const inviteResult = await useVerificationToken({
		identifier: email,
		token: hashVerificationToken(token, config.secret),
	});
	if (inviteResult.isErr()) {
		log.error('Email verify token lookup failed', serializeError(inviteResult.error));
		redirectToLoginError(res, config.appUrl, 'Callback');
		return;
	}

	const invite = inviteResult.value;
	if (!invite || invite.expires.valueOf() < Date.now()) {
		redirectToLoginError(res, config.appUrl, 'Verification');
		return;
	}

	const existingResult = await getUserByEmail(email);
	if (existingResult.isErr()) {
		log.error('Email verify user lookup failed', serializeError(existingResult.error));
		redirectToLoginError(res, config.appUrl, 'Callback');
		return;
	}

	if (existingResult.value) {
		const updatedResult = await setUserEmailVerified(existingResult.value.id);
		if (updatedResult.isErr()) {
			log.error('Email verify failed to update emailVerified', serializeError(updatedResult.error));
			redirectToLoginError(res, config.appUrl, 'Callback');
			return;
		}

		await establishSessionAndRedirect(res, {appUrl: config.appUrl, callbackUrl, userId: updatedResult.value.id});
		return;
	}

	if (!canSignUp(email)) {
		redirectToLoginError(res, config.appUrl, 'SignupNotAllowed');
		return;
	}

	const createdResult = await createUserFromEmail(email);
	if (createdResult.isErr()) {
		log.error('Email verify failed to create user', serializeError(createdResult.error));
		redirectToLoginError(res, config.appUrl, 'Callback');
		return;
	}

	await establishSessionAndRedirect(res, {appUrl: config.appUrl, callbackUrl, userId: createdResult.value.id});
}
