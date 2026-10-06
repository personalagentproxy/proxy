import {Ok, Result} from 'ts-results-es';

import {wrapDb, type ApiError} from '@proxy/utils';

import {db, Prisma} from '.';

export type AuthenticatedSession = {
	sessionToken: string;
	userId: string;
	user: {
		email: string;
		name: string | null;
	};
	expires: Date;
};

/** `Ok(null)` means no live session: the token is unknown or expired. */
export async function getAuthenticatedSessionDatabase(
	sessionToken: string,
): Promise<Result<AuthenticatedSession | null, ApiError>> {
	const result = await wrapDb(() =>
		db.session.findUnique({
			where: {sessionToken},
			select: {
				sessionToken: true,
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
		sessionToken: session.sessionToken,
		userId: session.userId,
		user: {
			email: session.user.email,
			name: session.user.name,
		},
		expires: session.expires,
	});
}

export async function createSession(data: {
	sessionToken: string;
	userId: string;
	expires: Date;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.create({data}))).map(() => undefined);
}

export async function deleteSessionByToken(sessionToken: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.deleteMany({where: {sessionToken}}))).map(() => undefined);
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

/** The token columns are snake_case because they mirror the OAuth token response. */
export async function createOAuthAccount(data: {
	userId: string;
	type: string;
	provider: string;
	providerAccountId: string;
	access_token: string | null;
	refresh_token: string | null;
	expires_at: number | null;
	token_type: string | null;
	scope: string | null;
	id_token: string | null;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.account.create({data}))).map(() => undefined);
}
