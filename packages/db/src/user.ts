import type {User} from '@prisma/client';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {
	buildBaseSlug,
	isSlugUniqueConflict,
	pickAvailableSlugDatabase,
	planPersonalOrgIdentity,
	vaultFor,
} from './organization';

export type CreatedUser = {id: string; email: string; name: string | null};

const createdUserSelect = {id: true, email: true, name: true} as const;

const MAX_SLUG_ATTEMPTS = 5;

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

/**
 * Creates the user together with their first organization, which they own, their membership and
 * their own vault there, in one transaction, so no user exists without them. Retries when a parallel sign-up took the slug.
 * Every sign-up comes through the sign-in page, past its notice of the terms, so the terms count as
 * accepted from the start.
 */
async function createUserWithPersonalOrg(data: {
	email: string;
	name: string | null;
	image?: string | null;
	emailVerified?: Date;
}): Promise<Result<CreatedUser, ApiError>> {
	const {name, slugSource} = planPersonalOrgIdentity(data);
	const base = buildBaseSlug(slugSource);

	for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
		const result = await wrapDb(() =>
			db.$transaction(async (tx) => {
				const user = await tx.user.create({
					data: {...data, termsAcceptedAt: new Date()},
					select: createdUserSelect,
				});
				const slug = await pickAvailableSlugDatabase(tx, base);
				const org = await tx.organization.create({data: {name, slug, ownerUserId: user.id}});
				await tx.orgMember.create({data: {orgId: org.id, userId: user.id}});
				await tx.connection.create({data: vaultFor({orgId: org.id, userId: user.id, name})});
				return user;
			}),
		);

		if (result.isOk()) {
			return result;
		}
		if (!isSlugUniqueConflict(result.error)) {
			return result;
		}
	}

	return Err(ApiErr.dbError(new Error(`Slug conflict retries exhausted for base "${base}"`)));
}

/** A Google sign-up: name and picture from the profile, email not marked verified. */
export async function createUserFromOAuthProfile(data: {
	email: string;
	name: string | null;
	image: string | null;
}): Promise<Result<CreatedUser, ApiError>> {
	return createUserWithPersonalOrg(data);
}

/** A magic-link sign-up: clicking the link verified the email. */
export async function createUserFromEmail(email: string): Promise<Result<CreatedUser, ApiError>> {
	return createUserWithPersonalOrg({email, name: null, emailVerified: new Date()});
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

export async function createUser(data: {
	email: string;
	name: string;
	emailVerified: Date;
}): Promise<Result<CreatedUser, ApiError>> {
	return createUserWithPersonalOrg(data);
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
			await tx.user.delete({where: {id: userId}});
		}),
	);
}
