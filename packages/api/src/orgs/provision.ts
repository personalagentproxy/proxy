import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {buildBaseSlug, provisionOrganization, type NewUser} from '@proxy/db/organization';
import type {CreatedUser} from '@proxy/db/user';

import {ORGANIZATION_CONNECTIONS} from './starter-connections';

// A person signing up gets an organization of their own, named after them; one made later has
// been through the welcome flow from the start, which is the first organization's.

/**
 * The display name and slug source of a user's personal organization: `<First>'s Workspace`,
 * else `<email-local>'s Workspace`. A first name with no Latin letters still names the
 * organization, but the slug comes from the email so it isn't just `s-workspace`.
 */
export function planPersonalOrgIdentity(identity: {name?: string | null; email: string}): {name: string; slugSource: string} {
	const firstName = (identity.name?.trim() ?? '').split(/\s+/)[0] ?? '';
	const emailLocal = identity.email.split('@')[0]?.trim() ?? '';

	const display = firstName || emailLocal;
	const name = display ? `${display}'s Workspace` : 'Workspace';

	const firstNameYieldsLatinSlug = firstName && buildBaseSlug(firstName) !== 'workspace';
	const slugDisplay = firstNameYieldsLatinSlug ? firstName : emailLocal || display;
	const slugSource = slugDisplay ? `${slugDisplay}'s Workspace` : 'Workspace';

	return {name, slugSource};
}

/**
 * A new user with their first organization, which they own, in one transaction, so no user exists
 * without one. Every sign-up comes through the sign-in page, past its notice of the terms, so the
 * terms count as accepted from the start.
 */
export async function signUp(user: Omit<NewUser, 'termsAcceptedAt' | 'createdAt'>): Promise<Result<CreatedUser, ApiError>> {
	const {name, slugSource} = planPersonalOrgIdentity(user);
	const made = await provisionOrganization({
		owner: {user: {...user, termsAcceptedAt: new Date()}},
		name,
		slugSource,
		onboardedAt: null,
		connections: ORGANIZATION_CONNECTIONS,
	});
	return made.map(({ownerUserId}) => ({id: ownerUserId, email: user.email, name: user.name}));
}

/** Another organization the person makes, which they own, named as they say. */
export async function createOrganization(data: {userId: string; name: string}): Promise<Result<{id: string; slug: string; name: string}, ApiError>> {
	const made = await provisionOrganization({
		owner: {userId: data.userId},
		name: data.name,
		slugSource: data.name,
		onboardedAt: new Date(),
		connections: ORGANIZATION_CONNECTIONS,
	});
	return made.map(({org}) => org);
}
