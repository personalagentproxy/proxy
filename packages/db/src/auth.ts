import {Ok, Result} from 'ts-results-es';

import {type ApiError, type Experiment, organizationExperiments, wrapDb} from '@proxy/utils';

import {db, Prisma} from '.';

export type AuthenticatedSession = {
	userId: string;
	// The organization the session has open in the switcher; none until one is picked.
	activeOrgId: string | null;
	user: {
		email: string;
		name: string | null;
	};
	/** The experiments on for the organization the session works in. */
	experiments: Experiment[];
	expires: Date;
};

/**
 * By the hash of the cookie's token. `Ok(null)` means no live session: unknown or expired. The
 * experiments are the organization's the session works in: the one open, while the user is still
 * a member of it, else the first one they joined, as `getUserOrgId` picks it.
 */
export async function getAuthenticatedSessionDatabase(
	tokenHash: string,
): Promise<Result<AuthenticatedSession | null, ApiError>> {
	const result = await wrapDb(() =>
		db.session.findUnique({
			where: {tokenHash},
			select: {
				userId: true,
				activeOrgId: true,
				user: {
					select: {
						name: true,
						email: true,
						orgMembers: {
							select: {orgId: true, org: {select: {insider: true, experiments: true}}},
							orderBy: {createdAt: 'asc'},
						},
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

	const memberships = session.user.orgMembers;
	const organization = (
		memberships.find((member) => member.orgId === session.activeOrgId) ?? memberships[0]
	)?.org;
	return Ok({
		userId: session.userId,
		activeOrgId: session.activeOrgId,
		user: {
			email: session.user.email,
			name: session.user.name,
		},
		experiments: organization ? organizationExperiments(organization) : [],
		expires: session.expires,
	});
}

export async function createSession(data: {
	tokenHash: string;
	userId: string;
	expires: Date;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.create({data}))).map(() => undefined);
}

/** Opens an organization in the session's switcher; the caller has checked the user is a member. */
export async function setSessionActiveOrg(
	tokenHash: string,
	orgId: string,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() => db.session.updateMany({where: {tokenHash}, data: {activeOrgId: orgId}}))
	).map(() => undefined);
}

export async function deleteSession(tokenHash: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.session.deleteMany({where: {tokenHash}}))).map(() => undefined);
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
