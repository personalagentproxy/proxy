import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * Slack: the workspaces linked to an organization (SlackWorkspace) and its shared personas' Slack
 * apps in them (SlackApp). Secrets are stored as the api encrypts them; nothing here reads them.
 * A workspace's configuration token is rotated under a lock on its row, so a refresh token, which
 * works once, is spent by one api instance; the sweep takes the workspaces due as the alerts' does,
 * moving each on as it takes it. A persona's app is made under a lock on the persona's row, as its
 * maker taking it back is (takeBackPersona), so only a shared persona gets one, and keeps it.
 */

export type SlackWorkspaceRow = {
	id: string;
	orgId: string;
	teamId: string;
	name: string;
	slackUserId: string;
	// `{token, refreshToken}`, encrypted.
	credential: string;
	expiresAt: Date;
	refusedAt: Date | null;
	createdAt: Date;
};

const workspaceSelect = {
	id: true,
	orgId: true,
	teamId: true,
	name: true,
	slackUserId: true,
	credential: true,
	expiresAt: true,
	refusedAt: true,
	createdAt: true,
} as const;

export type SlackAppRow = {
	id: string;
	orgId: string;
	personaId: string;
	workspaceId: string;
	slackAppId: string | null;
	clientId: string | null;
	// `{clientSecret, signingSecret}`, encrypted.
	secrets: string | null;
	manifestVersion: number;
	manifestName: string;
	// Encrypted.
	botToken: string | null;
	botUserId: string | null;
	botName: string | null;
	scopes: string[];
	installedAt: Date | null;
	removedAt: Date | null;
	createdAt: Date;
};

const appSelect = {
	id: true,
	orgId: true,
	personaId: true,
	workspaceId: true,
	slackAppId: true,
	clientId: true,
	secrets: true,
	manifestVersion: true,
	manifestName: true,
	botToken: true,
	botUserId: true,
	botName: true,
	scopes: true,
	installedAt: true,
	removedAt: true,
	createdAt: true,
} as const;

/** The organization's linked workspaces, oldest first, each with how many personas' apps are in it. */
export async function listSlackWorkspaces(
	orgId: string,
): Promise<Result<Array<SlackWorkspaceRow & {apps: number}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackWorkspace.findMany({
				where: {orgId},
				select: {...workspaceSelect, _count: {select: {apps: true}}},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map((rows) => rows.map(({_count, ...row}) => ({...row, apps: _count.apps})));
}

/** One of the organization's linked workspaces; `Ok(null)` for none. */
export async function getSlackWorkspace(
	orgId: string,
	workspaceId: string,
): Promise<Result<SlackWorkspaceRow | null, ApiError>> {
	return wrapDb(() =>
		db.slackWorkspace.findFirst({where: {id: workspaceId, orgId}, select: workspaceSelect}),
	);
}

/** A workspace's token as a member pasted it and it was first rotated: what linking it keeps. */
export type LinkedSlackWorkspace = {
	orgId: string;
	teamId: string;
	name: string;
	slackUserId: string;
	linkedById: string;
	credential: string;
	expiresAt: Date;
	rotateAt: Date;
};

/**
 * Links the workspace to the organization, or gives the one linked already its new token, which is
 * how a token Slack turned down is pasted again: it works again from now.
 */
export async function linkSlackWorkspace(
	linked: LinkedSlackWorkspace,
): Promise<Result<SlackWorkspaceRow, ApiError>> {
	const {orgId, teamId, ...rest} = linked;
	return wrapDb(() =>
		db.slackWorkspace.upsert({
			where: {orgId_teamId: {orgId, teamId}},
			create: {orgId, teamId, ...rest},
			update: {...rest, refusedAt: null},
			select: workspaceSelect,
		}),
	);
}

/** What unlinking a workspace came to: done, refused while a persona's app is in it, or no such workspace. */
export type Unlink = 'unlinked' | 'in_use' | 'missing';

/** Unlinks the workspace, while no persona's app is in it; the row is locked, so none is made meanwhile (startSlackApp). */
export async function unlinkSlackWorkspace(
	orgId: string,
	workspaceId: string,
): Promise<Result<Unlink, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx): Promise<Unlink> => {
			const locked = await tx.$queryRaw<Array<{id: string}>>`
				SELECT "id" FROM "SlackWorkspace" WHERE "id" = ${workspaceId} AND "orgId" = ${orgId} FOR UPDATE`;
			if (locked.length === 0) {
				return 'missing';
			}
			if ((await tx.slackApp.count({where: {workspaceId}})) > 0) {
				return 'in_use';
			}
			await tx.slackWorkspace.delete({where: {id: workspaceId}});
			return 'unlinked';
		}),
	);
}

/**
 * The workspaces due to have their token rotated, at most `limit`, each moved on `leaseMs` as it is
 * taken, so another instance's sweep doesn't take it meanwhile, and one that fails comes again
 * then. One whose refresh token Slack turned down is never due.
 */
export async function claimDueSlackWorkspaces(
	leaseMs: number,
	limit: number,
): Promise<Result<string[], ApiError>> {
	return (
		await wrapDb(
			() => db.$queryRaw<Array<{id: string}>>`
				UPDATE "SlackWorkspace" SET "rotateAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000})
				WHERE "id" IN (
					SELECT "id" FROM "SlackWorkspace"
					WHERE "rotateAt" <= now() AT TIME ZONE 'UTC' AND "refusedAt" IS NULL
					ORDER BY "rotateAt"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				RETURNING "id"`,
		)
	).map((rows) => rows.map(({id}) => id));
}

/**
 * What became of a workspace's token as it was looked at under the lock: fresh enough as it is;
 * rotated, with the new one, when it runs out and when the sweep is to take it next; turned down by
 * Slack for good; or not rotated this time, for a reason to pass on, such as Slack being away.
 */
export type Rotation =
	| {kind: 'fresh'}
	| {kind: 'rotated'; credential: string; expiresAt: Date; rotateAt: Date}
	| {kind: 'refused'}
	| {kind: 'failed'; error: ApiError};

// Long enough for a call to Slack under the lock, which times out well before.
const ROTATION_TIMEOUT_MS = 30_000;

/**
 * Looks at the workspace's token under a lock on its row, so that two instances never spend one
 * refresh token: `rotate` says what became of it, from the row as it is now, after any other
 * instance's rotation, and that is written. The row as it is after; `Ok(null)` for no such
 * workspace.
 */
export async function rotateSlackWorkspace(
	workspaceId: string,
	rotate: (row: SlackWorkspaceRow) => Promise<Rotation>,
): Promise<Result<{row: SlackWorkspaceRow; rotation: Rotation} | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "SlackWorkspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
				const row = await tx.slackWorkspace.findUnique({
					where: {id: workspaceId},
					select: workspaceSelect,
				});
				if (!row) {
					return null;
				}
				const rotation = await rotate(row);
				if (rotation.kind === 'rotated') {
					const {credential, expiresAt, rotateAt} = rotation;
					return {
						row: await tx.slackWorkspace.update({
							where: {id: workspaceId},
							data: {credential, expiresAt, rotateAt, refusedAt: null},
							select: workspaceSelect,
						}),
						rotation,
					};
				}
				if (rotation.kind === 'refused') {
					return {
						row: await tx.slackWorkspace.update({
							where: {id: workspaceId},
							data: {refusedAt: new Date()},
							select: workspaceSelect,
						}),
						rotation,
					};
				}
				return {row, rotation};
			},
			{timeout: ROTATION_TIMEOUT_MS},
		),
	);
}

/** The persona's Slack app; `Ok(null)` for none. */
export async function getPersonaSlackApp(
	personaId: string,
): Promise<Result<SlackAppRow | null, ApiError>> {
	return wrapDb(() => db.slackApp.findUnique({where: {personaId}, select: appSelect}));
}

/** A Slack app by our id for it, as Slack's events name it, with what its organization has on. */
export async function getSlackAppForEvents(
	id: string,
): Promise<
	Result<(SlackAppRow & {org: {experiments: string[]; insider: boolean}}) | null, ApiError>
> {
	return wrapDb(() =>
		db.slackApp.findUnique({
			where: {id},
			select: {...appSelect, org: {select: {experiments: true, insider: true}}},
		}),
	);
}

/** A persona's app before it is in Slack: what it is to be made with, and who added it. */
export type NewSlackApp = {
	orgId: string;
	personaId: string;
	workspaceId: string;
	manifestVersion: number;
	manifestName: string;
	addedById: string;
};

/** What starting a persona's app came to: the row, or refused as the persona isn't shared, already has one, or the workspace is gone. */
export type SlackAppStart =
	| {kind: 'started'; app: SlackAppRow}
	| {kind: 'not_shared'}
	| {kind: 'exists'}
	| {kind: 'no_workspace'};

/**
 * Makes the row for the persona's app, before Slack makes the app, since the address its events
 * go to names it: with the persona's row locked, so it is made only for one that is shared and
 * stays so (takeBackPersona), one per persona; and the workspace's, so it isn't unlinked meanwhile.
 */
export async function startSlackApp(app: NewSlackApp): Promise<Result<SlackAppStart, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx): Promise<SlackAppStart> => {
			const persona = await tx.$queryRaw<Array<{id: string}>>`
				SELECT "id" FROM "Persona" WHERE "id" = ${app.personaId} AND "orgId" = ${app.orgId} AND "ownerUserId" IS NULL FOR UPDATE`;
			if (persona.length === 0) {
				return {kind: 'not_shared'};
			}
			const workspace = await tx.$queryRaw<Array<{id: string}>>`
				SELECT "id" FROM "SlackWorkspace" WHERE "id" = ${app.workspaceId} AND "orgId" = ${app.orgId} FOR UPDATE`;
			if (workspace.length === 0) {
				return {kind: 'no_workspace'};
			}
			if ((await tx.slackApp.count({where: {personaId: app.personaId}})) > 0) {
				return {kind: 'exists'};
			}
			return {kind: 'started', app: await tx.slackApp.create({data: app, select: appSelect})};
		}),
	);
}

/** The app as Slack made it: its id and client, and its secrets, encrypted. */
export async function finishSlackApp(
	id: string,
	made: {slackAppId: string; clientId: string; secrets: string},
): Promise<Result<SlackAppRow, ApiError>> {
	return wrapDb(() => db.slackApp.update({where: {id}, data: made, select: appSelect}));
}

/** Forgets the app here, whatever became of it in Slack; `Ok(false)` where it was gone already. */
export async function forgetSlackApp(id: string): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.slackApp.deleteMany({where: {id}}))).map(({count}) => count > 0);
}

/** What installing the app gave: the bot's token, encrypted, its user id and handle, and the scopes granted. */
export type SlackInstall = {
	botToken: string;
	botUserId: string;
	botName: string | null;
	scopes: string[];
	workspaceName: string;
};

/** The app installed: in Slack from now, with the workspace's name as Slack said it then. */
export async function installSlackApp(
	id: string,
	install: SlackInstall,
): Promise<Result<SlackAppRow, ApiError>> {
	const {workspaceName, ...bot} = install;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const app = await tx.slackApp.update({
				where: {id},
				data: {...bot, installedAt: new Date(), removedAt: null},
				select: appSelect,
			});
			await tx.slackWorkspace.update({where: {id: app.workspaceId}, data: {name: workspaceName}});
			return app;
		}),
	);
}

/** The app as Slack has it after an update: the manifest's version and the name it was given. */
export async function updateSlackAppManifest(
	id: string,
	manifest: {manifestVersion: number; manifestName: string},
): Promise<Result<SlackAppRow, ApiError>> {
	return wrapDb(() => db.slackApp.update({where: {id}, data: manifest, select: appSelect}));
}

/** The app removed in Slack: its token forgotten, until it is installed again. */
export async function markSlackAppRemoved(id: string): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackApp.updateMany({where: {id}, data: {removedAt: new Date(), botToken: null}}),
		)
	).map(() => undefined);
}

/** The workspace's token turned down by Slack for good, as a call with it found: a member has to paste one again. */
export async function refuseSlackWorkspace(id: string): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() => db.slackWorkspace.updateMany({where: {id}, data: {refusedAt: new Date()}}))
	).map(() => undefined);
}
