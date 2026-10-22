import {findIntegration} from '@proxy/integrations';
import type {Me} from '@/client/me-client';
import type {Org} from '@/client/orgs-client';
import type {Connection} from '@/lib/types';

// The human side's organizations: the one in the address, and who else is in each.

// What the human side's route loads: who is signed in, the organization the address names, and
// the organizations they are in, for the switcher.
export type Human = Me & {org: Org; orgs: Org[]};

/** Whether anyone else is in the organization or invited to it. */
export function hasOtherPeople(org: Org): boolean {
	return org.memberCount > 1 || org.invitationCount > 0;
}

/** The organizations the person owns: deleting their account deletes them, whoever else is in them. */
export function ownedOrgs(orgs: Org[]): Org[] {
	return orgs.filter((org) => org.role === 'owner');
}

/**
 * Who the provider sees when an agent uses the connection: whoever signed in, for an integration
 * connected by signing in to it; the account itself for a mailbox, a database's user, a key or a
 * custom server.
 */
export function actsAs(connection: Connection, connectedBy: string | null): string {
	if (!findIntegration(connection.integrationId)?.signIn) {
		return connection.account;
	}
	if (connectedBy === null) {
		return 'whoever signed in';
	}
	return `${connectedBy}, who signed in`;
}
