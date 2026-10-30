import {randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';
import {Ok, type Result} from 'ts-results-es';

import {type CreatedUser, getUserByEmail} from '@proxy/db/user';
import type {ApiError} from '@proxy/utils';

import {log} from '../observability/log';
import {signUp} from '../orgs/provision';
import {env} from '../utils/env';
import {establishSession} from './session';

// Accounts made by this route share the domain, so they're easy to spot and delete.
const DEV_USER_EMAIL_DOMAIN = 'dev.proxy.local';
const DEV_USER_EMAIL = `dev@${DEV_USER_EMAIL_DOMAIN}`;

/**
 * `POST /auth/dev/login` — signs the browser in as the dev user, made on its first sign-in and the
 * same one every time after, skipping Google and the magic link. With `{fresh: true}` it makes a
 * throwaway user instead, whose organization still has the welcome flow ahead of it, as the screen
 * map's crawl needs. Any NODE_ENV but development gets a 404, as if the route did not exist.
 */
export async function handleDevLoginRoute(req: Request, res: Response): Promise<void> {
	if (env.NODE_ENV !== 'development') {
		res.status(404).json({error: 'not_found'});
		return;
	}

	const fresh = req.body?.fresh === true;
	const userResult = fresh ? await createThrowawayUser() : await findOrCreateDevUser();
	if (userResult.isErr()) {
		log.error('[Dev Login] Failed to find or create dev user', {fresh});
		res.status(500).json({error: 'user_creation_failed'});
		return;
	}
	const user = userResult.value;

	const sessionResult = await establishSession(res, user.id);
	if (sessionResult.isErr()) {
		log.error('[Dev Login] Failed to create session', {userId: user.id});
		res.status(500).json({error: 'session_creation_failed'});
		return;
	}

	log.info('[Dev Login] Signed in as dev user', {userId: user.id, email: user.email});
	res.json({ok: true});
}

async function findOrCreateDevUser(): Promise<Result<CreatedUser, ApiError>> {
	const existing = await getUserByEmail(DEV_USER_EMAIL);
	if (existing.isErr()) {
		return existing;
	}
	if (existing.value) {
		return Ok(existing.value);
	}

	return signUp({email: DEV_USER_EMAIL, name: 'Dev User', emailVerified: new Date()});
}

function createThrowawayUser(): Promise<Result<CreatedUser, ApiError>> {
	const email = `dev-${randomBytes(8).toString('hex')}@${DEV_USER_EMAIL_DOMAIN}`;
	return signUp({email, name: 'Dev User', emailVerified: new Date()});
}
