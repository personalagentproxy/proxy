import type {Me} from '@/client/me-client';
import type {Org} from '@/client/orgs-client';

// The human side's organizations: the one open in the switcher, and who else is in each.

// What the human side's route loads: who is signed in and the organizations they are in.
export type Human = Me & {orgs: Org[]};

/** The organization open in the switcher, as the list has it, with its counts. */
export function activeOrgOf(human: Human): Org {
	return (
		human.orgs.find((org) => org.id === human.org.id) ?? {
			...human.org,
			memberCount: 1,
			invitationCount: 0,
		}
	);
}

/** Whether anyone else is in the organization or invited to it. */
export function hasOtherPeople(org: Org): boolean {
	return org.memberCount > 1 || org.invitationCount > 0;
}

/** The organizations the person owns: deleting their account deletes them, whoever else is in them. */
export function ownedOrgs(orgs: Org[]): Org[] {
	return orgs.filter((org) => org.role === 'owner');
}
