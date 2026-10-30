import type {User} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type CreatedUser = {id: string; email: string; name: string | null};

const createdUserSelect = {id: true, email: true, name: true} as const;

export async function getUserFromId(id: string): Promise<Result<User | null, ApiError>> {
	return wrapDb(() => db.user.findUnique({where: {id}}));
}

/** Exact match on the unique email column. */
export async function getUserByEmail(email: string): Promise<Result<CreatedUser | null, ApiError>> {
	return wrapDb(() =>
		db.user.findUnique({
			where: {email},
			select: createdUserSelect,
		}),
	);
}

/** Every magic-link sign-in by an existing user verifies the email again. */
export async function setUserEmailVerified(userId: string): Promise<Result<CreatedUser, ApiError>> {
	return wrapDb(() =>
		db.user.update({
			where: {id: userId},
			data: {emailVerified: new Date()},
			select: createdUserSelect,
		}),
	);
}

/** Refreshes the public profile claims when an existing user signs in with Google again. */
export async function updateUserFromOAuthProfile(
	userId: string,
	profile: {name: string | null; image: string | null},
): Promise<Result<CreatedUser, ApiError>> {
	return wrapDb(() =>
		db.user.update({
			where: {id: userId},
			data: profile,
			select: createdUserSelect,
		}),
	);
}

/**
 * Deletes the user; the cascades take their accounts, sessions, memberships, their own connections
 * everywhere and the organizations they own, with those organizations' connections, vaults,
 * agents, other members and activity. Sign-in links still waiting for their address go too. The
 * caller has undone their connections at their providers and taken them out of every other
 * organization first.
 */
export async function deleteUser(userId: string): Promise<Result<void, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const user = await tx.user.findUnique({where: {id: userId}, select: {email: true}});
			if (user) {
				await tx.verificationToken.deleteMany({where: {identifier: user.email}});
			}
			// The clients they signed in as shared agents, which don't go with the user.
			await tx.oAuthCode.deleteMany({where: {userId}});
			await tx.oAuthGrant.deleteMany({where: {userId}});
			await tx.user.delete({where: {id: userId}});
		}),
	);
}
