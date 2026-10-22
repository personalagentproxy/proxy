import type {Org} from '@/client/orgs-client';
import type {Human} from '@/lib/orgs';

// The organization the address names in the web app's tests, as the api answers it: the person's
// own, alone in it.
export const testOrg: Org = {
	id: 'org-1',
	slug: 'acme',
	name: 'Acme',
	role: 'owner',
	onboarded: true,
	experiments: [],
	memberCount: 1,
	invitationCount: 0,
};

/** What the human side's route loads for the person signed in, in `org`. */
export function testHuman(org: Org = testOrg): Human {
	return {
		user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
		org,
		orgs: [org],
	};
}
