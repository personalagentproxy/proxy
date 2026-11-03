import {randomBytes} from 'node:crypto';

/** The hash of a password nobody knows, for a login nobody is to sign in with until it is given a new one. */
export function unknownPasswordHash(): Promise<string> {
	return Bun.password.hash(randomBytes(32).toString('base64url'));
}
