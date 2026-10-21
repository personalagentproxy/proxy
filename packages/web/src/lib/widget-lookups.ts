import {
	askAbout,
	findEmails,
	findEvents,
	findFiles,
	findMeetings,
	findPeople,
	findRecords,
	findTransactions,
	getAccounts,
	getAgenda,
	getMailboxes,
	getRates,
} from '@/client/widgets-client';
import {lookup} from '@/lib/lookup';
import {bestMatch, isAddress} from '@/lib/widget-values';

// What the home page's widgets read, each kept by what it asked, so typing on doesn't ask again
// for what it already has.

export const usePeople = lookup(findPeople);

/**
 * The address a name stands for: the name when it is one, else the closest contact's. `looking`
 * while the contacts are asked, for a search by it to wait, as one without it would only be replaced.
 */
export function useAddress(name: string | null): {address: string | null; looking: boolean} {
	const typed = name !== null && isAddress(name);
	const people = usePeople(name && !typed ? [name] : null);
	if (!name) {
		return {address: null, looking: false};
	}
	if (typed) {
		return {address: name, looking: false};
	}
	const address = bestMatch(people.data, name)?.emails[0] ?? null;
	return {address, looking: !address && people.loading};
}

export const useAgenda = lookup((range: {from: string; to: string}) =>
	getAgenda(new Date(range.from), new Date(range.to)),
);

export const useEvents = lookup(findEvents);

export const useEmails = lookup(findEmails);

export const useMailboxes = lookup((_all: true) => getMailboxes());

export const useFiles = lookup(findFiles);

export const useRates = lookup((_today: true) => getRates());

export const useAccounts = lookup((_all: true) => getAccounts());

export const useTransactions = lookup(findTransactions);

export const useMeetings = lookup(findMeetings);

export const useRecords = lookup(findRecords);

export const useAnswer = lookup(askAbout);
