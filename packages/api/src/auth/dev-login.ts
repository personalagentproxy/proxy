import {randomBytes} from 'node:crypto';

import type {Request, Response} from 'express';

import {createUser} from '@proxy/db/user';

import {log} from '../observability/log';
import {env} from '../utils/env';
import {establishSession} from './session';

// Throwaway accounts made by this route share the domain, so they're easy to spot and delete.
const DEV_USER_EMAIL_DOMAIN = 'dev.proxy.local';

/**
 * `POST /auth/dev/login` — creates a throwaway user and signs the browser in as them, skipping
 * Google and the magic link. Any NODE_ENV but development gets a 404, as if the route did not
 * exist.
 */
export async function handleDevLoginRoute(_req: Request, res: Response): Promise<void> {
	if (env.NODE_ENV !== 'development') {
		res.status(404).json({error: 'not_found'});
		return;
	}

	const email = `dev-${randomBytes(8).toString('hex')}@${DEV_USER_EMAIL_DOMAIN}`;

	const userResult = await createUser({email, name: 'Dev User', emailVerified: new Date()});
	if (userResult.isErr()) {
		log.error('[Dev Login] Failed to create dev user', {email});
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

	log.info('[Dev Login] Created throwaway dev user', {userId: user.id, email});
	res.json({ok: true});
}
