import type {FetchError} from '@proxy/utils';
import type {Result} from 'ts-results-es';
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
import {getRecord} from '@/client/records-client';
import {useOrgSlug} from '@/hooks/use-org';
import {lookup, type Lookup} from '@/lib/lookup';
import {bestMatch, isAddress} from '@/lib/widget-values';

// What the home page's widgets read, each kept by what it asked and the organization it asked
// in, so typing on doesn't ask again for what it already has.

// A lookup in the organization the address names: the hook reads it there, so a widget asks as it
// did before, and an answer is kept by the organization beside what was asked.
function orgLookup<A, T>(load: (org: string, args: A) => Promise<Result<T, FetchError>>) {
	const read = lookup((keyed: {org: string; args: A}) => load(keyed.org, keyed.args));
	function useOrgLookup(args: A | null): Lookup<T> {
		const org = useOrgSlug();
		return read(args === null ? null : {org, args});
	}
	return Object.assign(useOrgLookup, {clear: read.clear});
}

export const usePeople = orgLookup(findPeople);

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

export const useAgenda = orgLookup((org: string, range: {from: string; to: string}) =>
	getAgenda(org, new Date(range.from), new Date(range.to)),
);

export const useEvents = orgLookup(findEvents);

export const useEmails = orgLookup(findEmails);

/** One email whole, with its text, as its mailbox opens it. */
export const useEmail = orgLookup((org: string, email: {connectionId: string; id: string}) =>
	getRecord(org, email.connectionId, 'emails', email.id),
);

export const useMailboxes = orgLookup((org: string, _all: true) => getMailboxes(org));

export const useFiles = orgLookup(findFiles);

export const useRates = orgLookup((org: string, _today: true) => getRates(org));

export const useAccounts = orgLookup((org: string, _all: true) => getAccounts(org));

export const useTransactions = orgLookup(findTransactions);

export const useMeetings = orgLookup(findMeetings);

export const useRecords = orgLookup(findRecords);

export const useAnswer = orgLookup(askAbout);
