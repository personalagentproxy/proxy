import {Ok, type Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

// The one-time codes between the desktop app and the browser. Signing the app in: minted in the
// browser, signed in, for the PKCE challenge the app made; traded once by the app, with the
// verifier. Only the hash of a code is kept, so the table signs no one in.

export type DesktopAuthCodeRow = {
	userId: string;
	challenge: string;
	expires: Date;
};

/** Keeps a code; the expired ones go with it, so the table never holds more than the sign-ins under way. */
export async function createDesktopAuthCode(
	data: DesktopAuthCodeRow & {codeHash: string},
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction([
				db.desktopAuthCode.deleteMany({where: {expires: {lt: new Date()}}}),
				db.desktopAuthCode.create({data}),
			]),
		)
	).map(() => undefined);
}

/**
 * A code as it is, left where it is: `Ok(null)` when it is unknown or taken already. An expired
 * one is returned for the caller to refuse. Taking it is `takeDesktopAuthCode`, once the caller
 * has checked the verifier, so a wrong one does not use the code up on the app that holds it.
 */
export async function getDesktopAuthCode(
	codeHash: string,
): Promise<Result<DesktopAuthCodeRow | null, ApiError>> {
	return wrapDb(() =>
		db.desktopAuthCode.findUnique({
			where: {codeHash},
			select: {userId: true, challenge: true, expires: true},
		}),
	);
}

/** Takes a code, once: `Ok(false)` when it was gone already, taken by another request at the same moment. */
export async function takeDesktopAuthCode(codeHash: string): Promise<Result<boolean, ApiError>> {
	const result = await wrapDb(() => db.desktopAuthCode.deleteMany({where: {codeHash}}));
	if (result.isErr()) {
		return result;
	}

	return Ok(result.value.count > 0);
}

// The other way round: a code that signs the browser in as the app's person, for what has to
// happen there. Kept once, taken once.

export type DesktopHandoffRow = {
	userId: string;
	// Where the browser goes on to: a path in the app.
	next: string;
	expires: Date;
};

/** Keeps a handoff; the expired ones go with it. */
export async function createDesktopHandoff(
	data: DesktopHandoffRow & {codeHash: string},
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction([
				db.desktopHandoff.deleteMany({where: {expires: {lt: new Date()}}}),
				db.desktopHandoff.create({data}),
			]),
		)
	).map(() => undefined);
}

/**
 * Takes a handoff, once: `Ok(null)` when it is unknown or taken already, by this request or
 * another at the same moment. An expired one is returned for the caller to refuse.
 */
export async function takeDesktopHandoff(
	codeHash: string,
): Promise<Result<DesktopHandoffRow | null, ApiError>> {
	return wrapDb(async () => {
		const handoff = await db.desktopHandoff.findUnique({
			where: {codeHash},
			select: {id: true, userId: true, next: true, expires: true},
		});
		if (!handoff) {
			return null;
		}
		const {count} = await db.desktopHandoff.deleteMany({where: {id: handoff.id}});
		if (count === 0) {
			return null;
		}
		return {userId: handoff.userId, next: handoff.next, expires: handoff.expires};
	});
}
