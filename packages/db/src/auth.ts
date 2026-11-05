import {Ok, Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db, Prisma} from '.';

export type AuthenticatedSession = {
	id: string;
	userId: string;
	user: {
		email: string;
		name: string | null;
	};
	expires: Date;
};

/** By the hash of the cookie's token. `Ok(null)` means no live session: unknown or expired. */
export async function getAuthenticatedSessionDatabase(
	tokenHash: string,
): Promise<Result<AuthenticatedSession | null, ApiError>> {
	const result = await wrapDb(() =>
		db.session.findUnique({
			where: {tokenHash},
			select: {
				id: true,
				userId: true,
				user: {
					select: {
						name: true,
						email: true,
					},
				},
				expires: true,
			},
		}),
	);
	if (result.isErr()) {
		return result;
	}

	const session = result.value;
	if (!session) {
		return Ok(null);
	}

	if (session.expires <= new Date()) {
		return Ok(null);
	}

	return Ok({
		id: session.id,
		userId: session.userId,
		user: {
			email: session.user.email,
			name: session.user.name,
		},
		expires: session.expires,
	});
}

export async function createSession(data: {
	tokenHash: string;
	userId: string;
	expires: Date;
	userAgent: string | null;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.create({data}))).map(() => undefined);
}

export async function deleteSession(tokenHash: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.deleteMany({where: {tokenHash}}))).map(() => undefined);
}

export type UserSession = {
	id: string;
	userAgent: string | null;
	createdAt: Date;
};

/** A person's live sessions, the newest first; expired ones are left out, as signing in ignores them. */
export async function listUserSessions(userId: string): Promise<Result<UserSession[], ApiError>> {
	return wrapDb(() =>
		db.session.findMany({
			where: {userId, expires: {gt: new Date()}},
			select: {id: true, userAgent: true, createdAt: true},
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/** Signs one of a person's sessions out. `Ok(false)` means they have no session by that id. */
export async function deleteUserSession(args: {
	userId: string;
	sessionId: string;
}): Promise<Result<boolean, ApiError>> {
	const result = await wrapDb(() =>
		db.session.deleteMany({where: {id: args.sessionId, userId: args.userId}}),
	);
	return result.map((deleted) => deleted.count > 0);
}

/** Signs a person out everywhere but the session they are using; how many went. */
export async function deleteOtherUserSessions(args: {
	userId: string;
	keepSessionId: string;
}): Promise<Result<number, ApiError>> {
	const result = await wrapDb(() =>
		db.session.deleteMany({where: {userId: args.userId, id: {not: args.keepSessionId}}}),
	);
	return result.map((deleted) => deleted.count);
}

/** `Ok(null)` means the provider identity has never signed in here. */
export async function getAccountByProvider(
	provider: string,
	providerAccountId: string,
): Promise<Result<{userId: string} | null, ApiError>> {
	return wrapDb(() =>
		db.account.findUnique({
			where: {provider_providerAccountId: {provider, providerAccountId}},
			select: {userId: true},
		}),
	);
}

export type VerificationToken = {
	identifier: string;
	token: string;
	expires: Date;
};

/** `token` is the hash of the token in the emailed link, never the token itself. */
export async function createVerificationToken(
	data: VerificationToken,
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.verificationToken.create({data}))).map(() => undefined);
}

/**
 * Single use: deletes the token as it reads it, so a replayed link finds nothing. `Ok(null)`
 * means no such token, already used or never issued. Expiry is the caller's check.
 */
export async function useVerificationToken(args: {
	identifier: string;
	token: string;
}): Promise<Result<VerificationToken | null, ApiError>> {
	return wrapDb(async () => {
		const result = await Result.wrapAsync(() =>
			db.verificationToken.delete({
				where: {identifier_token: {identifier: args.identifier, token: args.token}},
				select: {identifier: true, token: true, expires: true},
			}),
		);
		if (result.isOk()) {
			return result.value;
		}

		// P2025 = "record not found" — the no-such-token case, not a failure.
		if (
			result.error instanceof Prisma.PrismaClientKnownRequestError &&
			result.error.code === 'P2025'
		) {
			return null;
		}

		throw result.error;
	});
}

export async function createOAuthAccount(data: {
	userId: string;
	type: string;
	provider: string;
	providerAccountId: string;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.account.create({data}))).map(() => undefined);
}
