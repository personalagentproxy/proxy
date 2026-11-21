import {createHmac, hkdfSync, timingSafeEqual} from 'node:crypto';

import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

/**
 * The token in a blob's URL (blobs.ts), its one credential: `blob_<payload>.<signature>`, the
 * payload the claims below as JSON and the signature an HMAC-SHA256 of `blob_<payload>`, both
 * base64url, as a sandbox command's token is made (cli/token.ts), with a key derived from
 * AUTH_SECRET for this purpose alone. A token to PUT makes blobs of the agent's; one to GET
 * reads the one blob it names. Nothing is stored: a token works until it runs out.
 */

const PREFIX = 'blob_';

// What HKDF is told the key is for, so it is never the key of anything else made from AUTH_SECRET.
const KEY_INFO = 'personal-agent-proxy blob url v1';

/** What a token lets its holder do: make blobs of the agent's, or read the agent's blob `blobId`, until `expiresAt`, in seconds since the epoch. */
export type BlobClaims = {kind: 'put'; orgId: string; agentId: string; expiresAt: number} | {kind: 'get'; orgId: string; agentId: string; blobId: string; expiresAt: number};

const claimsSchema = z.discriminatedUnion('k', [
	z.object({k: z.literal('put'), org: z.string().min(1), agent: z.string().min(1), exp: z.number().int()}),
	z.object({k: z.literal('get'), org: z.string().min(1), agent: z.string().min(1), blob: z.string().min(1), exp: z.number().int()}),
]);

/** Why a token doesn't work: not one of ours, or tampered with; or one of ours that has run out. */
export type BlobTokenError = 'invalid' | 'expired';

function sign(signed: string, secret: string): Buffer {
	const key = Buffer.from(hkdfSync('sha256', secret, '', KEY_INFO, 32));
	return createHmac('sha256', key).update(signed).digest();
}

/** A token for the claims, signed with a key made from `secret`. */
export function signBlobToken(claims: BlobClaims, secret: string): string {
	const common = {org: claims.orgId, agent: claims.agentId, exp: claims.expiresAt};
	const body = claims.kind === 'put' ? {k: 'put', ...common} : {k: 'get', ...common, blob: claims.blobId};
	const signed = `${PREFIX}${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
	return `${signed}.${sign(signed, secret).toString('base64url')}`;
}

/** The token's claims, where `secret` signed it and it has not run out by `now`. */
export function verifyBlobToken(token: string, secret: string, now = new Date()): Result<BlobClaims, BlobTokenError> {
	const dot = token.lastIndexOf('.');
	if (!token.startsWith(PREFIX) || dot === -1) {
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
	const claims = parsed.data;
	if (claims.exp * 1000 <= now.getTime()) {
		return Err('expired');
	}
	if (claims.k === 'put') {
		return Ok({kind: 'put', orgId: claims.org, agentId: claims.agent, expiresAt: claims.exp});
	}
	return Ok({kind: 'get', orgId: claims.org, agentId: claims.agent, blobId: claims.blob, expiresAt: claims.exp});
}
