import type {Connection} from '@proxy/contracts/connections';
import type {Me} from '@proxy/contracts/me';
import type {Org} from '@proxy/contracts/orgs';
import {findIntegration} from '@proxy/integrations';

// The human side's organizations: the one in the address, and who else is in each.

// What the human side's route loads: who is signed in, the organization the address names, and
// the organizations they are in, for the switcher.
export type Human = Me & {org: Org; orgs: Org[]};

/** Whether anyone else is in the organization or invited to it. */
export function hasOtherPeople(org: Org): boolean {
	return org.memberCount > 1 || org.invitationCount > 0;
}

// A connection or an agent, with who connected or made it.
type Managed = {shared: boolean} & ({connectedById: string | null} | {createdById: string | null});

/**
 * Whether the person may change a connection or an agent, as the api decides it: their own, or a
 * shared one they connected or made, or one in an organization they own. Anyone else uses a shared
 * one as it is.
 */
export function manages(human: Human, item: Managed): boolean {
	const byId = 'connectedById' in item ? item.connectedById : item.createdById;
	return !item.shared || byId === human.user.id || human.org.role === 'owner';
}

/**
 * Who connected a connection, at the start of a line: "You", a member by their name or address,
 * or "A former member" once they have left the organization.
 */
export function connectedBy(connection: Connection, human: Human): string {
	if (!connection.shared || connection.connectedById === human.user.id) {
		return 'You';
	}
	return connection.connectedBy ?? 'A former member';
}

/**
 * Who the provider sees when an agent uses the connection: whoever signed in, for an integration
 * connected by signing in to it; the account itself for a mailbox, a database's user, a key or a
 * custom server.
 */
export function actsAs(connection: Connection, human: Human): string {
	if (!findIntegration(connection.integrationId)?.signIn) {
		return connection.account;
	}
	if (!connection.shared || connection.connectedById === human.user.id) {
		return 'you, who signed in';
	}
	return `${connection.connectedBy ?? 'a former member'}, who signed in`;
}
