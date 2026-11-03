import {Ok, type Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

// The one-time codes that sign the desktop app in. Minted in the browser, signed in, for the PKCE
// challenge the app made; traded once by the app, with the verifier. Only the hash of a code is
// kept, so the table signs no one in.

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
