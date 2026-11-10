import {createHmac, hkdfSync, timingSafeEqual} from 'node:crypto';

import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

/**
 * The token a sandbox command is given with `pap: true` (native/sandbox/exec.ts), as `PAP_TOKEN`,
 * which code in the sandbox sends back to `/api/cli` as `Authorization: Bearer <token>`. It is
 * stateless: `pap_<payload>.<signature>`, the payload the claims below as JSON and the signature an
 * HMAC-SHA256 of `pap_<payload>`, both base64url. The key is derived from AUTH_SECRET for this
 * purpose alone, since AUTH_SECRET also hashes magic-link tokens. It lasts as long as the command
 * it was made for, and a little more; nothing is stored, and nothing needs revoking, since every
 * request checks what it names is still so (authenticate.ts).
 */

const PREFIX = 'pap_';

// What HKDF is told the key is for, so it is never the key of anything else made from AUTH_SECRET.
const KEY_INFO = 'personal-agent-proxy cli token v1';

/** Who the token is for: the agent and its organization, the task and sandbox the command ran for, and the Sandboxes connection. */
export type CliClaims = {
	agentId: string;
	orgId: string;
	taskId: string;
	sandboxId: string;
	connectionId: string;
	/** When it stops working, in seconds since the epoch. */
	expiresAt: number;
};

const claimsSchema = z.object({
	agent: z.string().min(1),
	org: z.string().min(1),
	task: z.string().min(1),
	sandbox: z.string().min(1),
	connection: z.string().min(1),
	exp: z.number().int(),
});

/** Why a token doesn't work: not one of ours, or tampered with; or one of ours that has run out. */
export type CliTokenError = 'invalid' | 'expired';

function keyOf(secret: string): Buffer {
	return Buffer.from(hkdfSync('sha256', secret, '', KEY_INFO, 32));
}

function sign(signed: string, secret: string): Buffer {
	return createHmac('sha256', keyOf(secret)).update(signed).digest();
}

/** A token for the claims, signed with a key made from `secret`. */
export function signCliToken(claims: CliClaims, secret: string): string {
	const payload = Buffer.from(
		JSON.stringify({agent: claims.agentId, org: claims.orgId, task: claims.taskId, sandbox: claims.sandboxId, connection: claims.connectionId, exp: claims.expiresAt}),
	).toString('base64url');
	const signed = `${PREFIX}${payload}`;
	return `${signed}.${sign(signed, secret).toString('base64url')}`;
}

/** The token's claims, where `secret` signed it and it has not run out by `now`. */
export function verifyCliToken(token: string, secret: string, now = new Date()): Result<CliClaims, CliTokenError> {
	if (!token.startsWith(PREFIX)) {
		return Err('invalid');
	}
	const dot = token.lastIndexOf('.');
	if (dot === -1) {
		return Err('invalid');
	}
	const signed = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = sign(signed, secret);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return Err('invalid');
	}
	const json = Result.wrap(() => JSON.parse(Buffer.from(signed.slice(PREFIX.length), 'base64url').toString('utf8')) as unknown);
	const parsed = claimsSchema.safeParse(json.unwrapOr(null));
	if (!parsed.success) {
		return Err('invalid');
	}
	const {agent, org, task, sandbox, connection, exp} = parsed.data;
	if (exp * 1000 <= now.getTime()) {
		return Err('expired');
	}
	return Ok({agentId: agent, orgId: org, taskId: task, sandboxId: sandbox, connectionId: connection, expiresAt: exp});
}
