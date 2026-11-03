import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {createStarterConnections, type StarterConnection} from './organization';

export type InvitationRow = {
	id: string;
	email: string;
	// Who sent it, by name or address; null once they are gone.
	invitedBy: string | null;
	expires: Date;
	createdAt: Date;
};

/** An organization's invitations not taken up yet, newest first, expired ones included. */
export async function listInvitations(orgId: string): Promise<Result<InvitationRow[], ApiError>> {
	return wrapDb(async () => {
		const invitations = await db.invitation.findMany({
			where: {orgId},
			orderBy: {createdAt: 'desc'},
			select: {id: true, email: true, invitedById: true, expires: true, createdAt: true},
		});
		const senders = await db.user.findMany({
			where: {id: {in: invitations.map((invitation) => invitation.invitedById)}},
			select: {id: true, name: true, email: true},
		});
		return invitations.map(({invitedById, ...invitation}) => {
			const sender = senders.find((user) => user.id === invitedById);
			return {...invitation, invitedBy: sender ? (sender.name ?? sender.email) : null};
		});
	});
}

/**
 * A new invitation, `tokenHash` the SHA-256 of the token in its link. One already waiting for the
 * address in the organization gives way to it, so the newest link is the one that works.
 */
export async function createInvitation(data: {
	orgId: string;
	email: string;
	tokenHash: string;
	invitedById: string;
	expires: Date;
}): Promise<Result<InvitationRow, ApiError>> {
	return wrapDb(async () => {
		const [, created] = await db.$transaction([
			db.invitation.deleteMany({where: {orgId: data.orgId, email: data.email}}),
			db.invitation.create({
				data,
				select: {id: true, email: true, expires: true, createdAt: true},
			}),
		]);
		const sender = await db.user.findUnique({
			where: {id: data.invitedById},
			select: {name: true, email: true},
		});
		return {...created, invitedBy: sender ? (sender.name ?? sender.email) : null};
	});
}

/** `Ok(false)` means no such invitation in the organization. */
export async function deleteInvitation(
	orgId: string,
	invitationId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.invitation.deleteMany({where: {id: invitationId, orgId}}))).map(
		({count}) => count > 0,
	);
}

export type InvitationForLink = {
	id: string;
	email: string;
	expires: Date;
	org: {id: string; slug: string; name: string};
	invitedBy: string | null;
};

/** The invitation a link's token is for; `Ok(null)` for none, taken up or revoked. */
export async function getInvitationByTokenHash(
	tokenHash: string,
): Promise<Result<InvitationForLink | null, ApiError>> {
	return wrapDb(async () => {
		const invitation = await db.invitation.findUnique({
			where: {tokenHash},
			select: {
				id: true,
				email: true,
				expires: true,
				invitedById: true,
				org: {select: {id: true, slug: true, name: true}},
			},
		});
		if (!invitation) {
			return null;
		}
		const sender = await db.user.findUnique({
			where: {id: invitation.invitedById},
			select: {name: true, email: true},
		});
		return {
			id: invitation.id,
			email: invitation.email,
			expires: invitation.expires,
			org: invitation.org,
			invitedBy: sender ? (sender.name ?? sender.email) : null,
		};
	});
}

/**
 * Takes an invitation up: the person becomes a member of its organization, with the starter
 * connections a member gets there, called by its name `orgName`, unless they already are, and the
 * invitation is gone.
 */
export async function acceptInvitation(data: {
	invitationId: string;
	orgId: string;
	userId: string;
	orgName: string;
	connections: StarterConnection[];
}): Promise<Result<void, ApiError>> {
	const {invitationId, orgId, userId, orgName, connections} = data;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const member = await tx.orgMember.findUnique({
				where: {orgId_userId: {orgId, userId}},
				select: {id: true},
			});
			if (!member) {
				await tx.orgMember.create({data: {orgId, userId}});
				await createStarterConnections(tx, connections, {orgId, userId, name: orgName});
			}
			await tx.invitation.deleteMany({where: {id: invitationId}});
		}),
	);
}
