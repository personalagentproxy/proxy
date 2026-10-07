import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import type {SignedInAgent} from './agent';

// Agents signing in over MCP with OAuth: the clients that registered themselves, the codes they
// exchange once, and the tokens of each client signed in as an agent. Codes and tokens are kept
// only as their SHA-256, so a leaked table signs no one in.

export type OAuthClientRow = {
	id: string;
	name: string;
	redirectUris: string[];
	secretHash: string | null;
};

const clientSelect = {id: true, name: true, redirectUris: true, secretHash: true} as const;

export async function createOAuthClient(
	data: OAuthClientRow,
): Promise<Result<OAuthClientRow, ApiError>> {
	return wrapDb(() => db.oAuthClient.create({data, select: clientSelect}));
}

/** `Ok(null)` means no client has the id. */
export async function getOAuthClient(id: string): Promise<Result<OAuthClientRow | null, ApiError>> {
	return wrapDb(() => db.oAuthClient.findUnique({where: {id}, select: clientSelect}));
}

export type OAuthCodeRow = {
	clientId: string;
	agentId: string;
	redirectUri: string;
	codeChallenge: string;
	expires: Date;
};

export async function createOAuthCode(
	data: OAuthCodeRow & {codeHash: string},
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.oAuthCode.create({data}))).map(() => undefined);
}

/**
 * Takes a code, once: `Ok(null)` when it is unknown or already taken, by this request or another
 * at the same moment. An expired one is returned for the caller to refuse.
 */
export async function takeOAuthCode(
	codeHash: string,
): Promise<Result<OAuthCodeRow | null, ApiError>> {
	return wrapDb(async () => {
		const code = await db.oAuthCode.findUnique({
			where: {codeHash},
			select: {
				id: true,
				clientId: true,
				agentId: true,
				redirectUri: true,
				codeChallenge: true,
				expires: true,
			},
		});
		if (!code) {
			return null;
		}
		const {count} = await db.oAuthCode.deleteMany({where: {id: code.id}});
		if (count === 0) {
			return null;
		}
		return {
			clientId: code.clientId,
			agentId: code.agentId,
			redirectUri: code.redirectUri,
			codeChallenge: code.codeChallenge,
			expires: code.expires,
		};
	});
}

export type OAuthTokens = {
	accessTokenHash: string;
	accessExpires: Date;
	refreshTokenHash: string;
	refreshExpires: Date;
};

export async function createOAuthGrant(
	data: OAuthTokens & {clientId: string; agentId: string},
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.oAuthGrant.create({data}))).map(() => undefined);
}

/** `Ok(null)` means no live token: unknown, expired, or the agent has been revoked. */
export async function getAgentByAccessToken(
	accessTokenHash: string,
): Promise<Result<SignedInAgent | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.oAuthGrant.findUnique({
				where: {accessTokenHash},
				select: {
					accessExpires: true,
					agent: {select: {id: true, orgId: true, providerId: true, name: true, revokedAt: true}},
				},
			}),
		)
	).map((grant) => {
		if (!grant || grant.accessExpires <= new Date() || grant.agent.revokedAt !== null) {
			return null;
		}
		const {agent} = grant;
		return {agentId: agent.id, orgId: agent.orgId, providerId: agent.providerId, name: agent.name};
	});
}

export type OAuthGrantForRefresh = {
	id: string;
	clientId: string;
	refreshExpires: Date;
	agentRevoked: boolean;
};

/** `Ok(null)` means no grant has the refresh token, an old one included. */
export async function getOAuthGrantByRefreshToken(
	refreshTokenHash: string,
): Promise<Result<OAuthGrantForRefresh | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.oAuthGrant.findUnique({
				where: {refreshTokenHash},
				select: {
					id: true,
					clientId: true,
					refreshExpires: true,
					agent: {select: {revokedAt: true}},
				},
			}),
		)
	).map(
		(grant) =>
			grant && {
				id: grant.id,
				clientId: grant.clientId,
				refreshExpires: grant.refreshExpires,
				agentRevoked: grant.agent.revokedAt !== null,
			},
	);
}

/**
 * Gives a grant new tokens, as long as its refresh token is still `previous`: `Ok(false)` when
 * another refresh got there first.
 */
export async function rotateOAuthGrant(
	id: string,
	previous: string,
	next: OAuthTokens,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.oAuthGrant.updateMany({where: {id, refreshTokenHash: previous}, data: next}),
		)
	).map(({count}) => count > 0);
}

export type OAuthGrantRow = {id: string; clientName: string; createdAt: Date};

/** The clients signed in as an agent of the organization, newest first. */
export async function listAgentOAuthGrants(
	orgId: string,
	agentId: string,
): Promise<Result<OAuthGrantRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.oAuthGrant.findMany({
				where: {agentId, agent: {orgId}},
				orderBy: {createdAt: 'desc'},
				select: {id: true, createdAt: true, client: {select: {name: true}}},
			}),
		)
	).map((grants) =>
		grants.map(({id, createdAt, client}) => ({id, clientName: client.name, createdAt})),
	);
}

/** Signs a client out of an agent. `Ok(false)` means no such grant for an agent of the organization. */
export async function deleteOAuthGrant(
	orgId: string,
	agentId: string,
	grantId: string,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() => db.oAuthGrant.deleteMany({where: {id: grantId, agentId, agent: {orgId}}}))
	).map(({count}) => count > 0);
}
