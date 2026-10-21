import {useSearchParams} from 'react-router';
import type {Org} from '@/client/orgs-client';
import {useHuman} from '@/hooks/use-human';
import {activeOrgOf, hasOtherPeople} from '@/lib/orgs';

// Who a new connection is for, in an organization with anyone else in it or invited:
// `?for=everyone` from Add connection on to the connection's form, which sends `shared`, and to a
// service's sign-in as `?share=everyone`, which the api keeps through it. Just you by default.
export function useShareChoice(): {
	org: Org | null;
	asked: boolean;
	shared: boolean;
	query: string;
} {
	const [params] = useSearchParams();
	const human = useHuman();
	const org = human ? activeOrgOf(human) : null;
	const asked = org !== null && hasOtherPeople(org);
	const shared = asked && params.get('for') === 'everyone';
	return {org, asked, shared, query: shared ? '?for=everyone' : ''};
}
