import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {env} from '../utils/env';
import {type CliClaims, signCliToken} from './token';

/**
 * What a sandbox command run with `pap: true` is given in its environment (native/sandbox/exec.ts):
 * `PAP_URL`, where this server is opened, and `PAP_TOKEN`, a token for the agent, its task and the
 * sandbox (token.ts), for code in the sandbox to call `/api/cli` with. Neither is a param of the
 * call, so neither reaches the activity log.
 */

// How much longer than the command's timeout the token lasts, for a call the command made just before it ended.
const GRACE_SECONDS = 30;

/** What signing a command's token takes: where this server is, and its secret. */
export type CliTokenConfig = {appUrl: string; secret: string};

/** The server's URL and secret, or unavailable, saying which is missing. */
export function requireCliTokenConfig(): Result<CliTokenConfig, ApiError> {
	const {AUTH_SECRET: secret, APP_URL: appUrl} = env;
	if (secret && appUrl) {
		return Ok({appUrl, secret});
	}
	const missing = [secret ? null : 'AUTH_SECRET', appUrl ? null : 'APP_URL'].filter((name) => name !== null);
	return Err(ApiErr.unavailable(`pap is not set up on this server: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Run the command without pap.`));
}

/** `PAP_URL` and `PAP_TOKEN` for a command that may run `timeoutSeconds` from `now`. */
export function cliCommandEnv(config: CliTokenConfig, claims: Omit<CliClaims, 'expiresAt'>, timeoutSeconds: number, now = new Date()): Record<string, string> {
	const expiresAt = Math.ceil(now.getTime() / 1000 + timeoutSeconds + GRACE_SECONDS);
	return {PAP_URL: config.appUrl, PAP_TOKEN: signCliToken({...claims, expiresAt}, config.secret)};
}
