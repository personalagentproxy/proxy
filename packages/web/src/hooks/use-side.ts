import {useSearchParams} from 'react-router';
import {useHuman} from '@/hooks/use-human';
import {hasOtherPeople} from '@/lib/orgs';

/** Which side of the organization a list shows, and how many each side has. */
export type SideChoice = {
	// Anyone else is in the organization or invited, so the list has two sides to pick from.
	others: boolean;
	shared: boolean;
	counts: {shared: number; yours: number};
	pick: (shared: boolean) => void;
};

/**
 * A list of what is shared with everyone in the organization and what is the person's own, as
 * Connections, Agents and Vault show it: with anyone else in it or invited, one side at a time, in
 * the address as `?for=me` or `?for=everyone`, opening on the shared one when `opensOnShared` and
 * it has any, else on the person's own; alone, everything at once.
 */
export function useSide<T extends {shared: boolean}>(
	items: T[],
	{opensOnShared}: {opensOnShared: boolean},
): SideChoice & {shown: T[]} {
	const [params, setParams] = useSearchParams();
	const human = useHuman();
	const others = human !== null && hasOtherPeople(human.org);
	const sharedCount = items.filter((item) => item.shared).length;
	const chosen = params.get('for');
	const shared =
		others && (chosen === 'everyone' || (chosen !== 'me' && opensOnShared && sharedCount > 0));
	return {
		others,
		shared,
		counts: {shared: sharedCount, yours: items.length - sharedCount},
		pick: (next) => setParams({for: next ? 'everyone' : 'me'}, {replace: true}),
		shown: others ? items.filter((item) => item.shared === shared) : items,
	};
}
